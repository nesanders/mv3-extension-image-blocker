const path = require('path');
const fs = require('fs');
const os = require('os');

const PID_FILE = path.join(os.tmpdir(), 'ctli-fixture-server.pid');

module.exports = async function globalTeardown() {
  if (!fs.existsSync(PID_FILE)) return;
  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10);
  try {
    process.kill(pid);
  } catch (e) {
    // already gone
  }
  fs.unlinkSync(PID_FILE);
};
