const synthetics = require('Synthetics');

exports.handler = async () => {
  const url = process.env.HEALTH_URL;
  const page = await synthetics.getPage();
  const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (!res || res.status() !== 200) throw new Error(`status ${res && res.status()}`);
  if (!(await res.text()).includes('"status":"ok"')) throw new Error('bad body');
};
