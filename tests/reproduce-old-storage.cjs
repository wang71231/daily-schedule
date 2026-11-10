// Run against the preserved pre-fix page. No real browser or user data is used.
const fs = require('node:fs');
const vm = require('node:vm');
const page = fs.readFileSync(process.argv[2], 'utf8');
const storage = new Map();
const ctx = vm.createContext({
  localStorage: {getItem:k=>storage.get(k)??null, setItem:(k,v)=>storage.set(k,v)},
  $:()=>({textContent:''}), window:{},
});
for (const name of ['readJson', 'writeStorage']) {
  vm.runInContext(page.split('\n').find(line=>line.startsWith(`function ${name}(`)), ctx);
}
vm.runInContext(`
  writeStorage('trainingLogs', {A:{status:'done'}, B:{status:'done'}});
  writeStorage('trainingLogs', {B:{status:'done'}});
  writeStorage('trainingLogs', {B:{status:'done',hours:2}});
`, ctx);
console.log('deleted record recoverable after next save:', JSON.parse(storage.get('trainingLogsLastGood')).A !== undefined);
vm.runInContext(`
  const tabA=readJson('trainingLogs', {}), tabB=readJson('trainingLogs', {});
  tabA.C={status:'done'}; tabB.D={status:'done'};
  writeStorage('trainingLogs',tabA); writeStorage('trainingLogs',tabB);
`, ctx);
console.log('both concurrent new records retained:', Boolean(JSON.parse(storage.get('trainingLogs')).C && JSON.parse(storage.get('trainingLogs')).D));
