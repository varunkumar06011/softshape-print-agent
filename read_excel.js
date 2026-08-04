const xlsx = require('xlsx');
const wb = xlsx.readFile('C:/Users/kiran/Downloads/git branch/RATES_BAR.xlsx');
const sheet = wb.Sheets[wb.SheetNames[0]];
const data = xlsx.utils.sheet_to_json(sheet, {header: 1});
console.log(JSON.stringify(data.slice(0, 10), null, 2));
