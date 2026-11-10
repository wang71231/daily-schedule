"""Initialize a hosted password via stdin. Does not write real credentials to files."""
import argparse
import getpass
import hashlib
import os
from pathlib import Path
import secrets
import subprocess

parser=argparse.ArgumentParser()
parser.add_argument('--local-test',action='store_true',help='Write only the well-known disposable local test password')
args=parser.parse_args()
password='isolated-local-test-only' if args.local_test else getpass.getpass('New website password (6-128 characters): ')
if not 6<=len(password)<=128:raise SystemExit('Password must be 6-128 characters')
if not args.local_test and password!=getpass.getpass('Confirm password: '):raise SystemExit('Passwords do not match')
salt=secrets.token_hex(16)
digest=hashlib.pbkdf2_hmac('sha256',password.encode(),bytes.fromhex(salt),100000).hex()
value=f'pbkdf2_sha256$100000${salt}${digest}'
root=Path(__file__).resolve().parents[1]
if args.local_test:
    path=root/'.dev.vars'
    if path.exists():raise SystemExit('.dev.vars already exists; inspect it before replacing any local settings')
    path.write_text(f'SCHEDULE_PASSWORD_HASH="{value}"\n',encoding='utf-8')
    print('Created ignored local-test configuration; never deploy this password.')
else:
    executable='npx.cmd' if os.name=='nt' else 'npx'
    result=subprocess.run([executable,'wrangler','secret','put','SCHEDULE_PASSWORD_HASH'],input=value+'\n',text=True,cwd=root)
    raise SystemExit(result.returncode)
