const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PID_FILE = path.join(os.tmpdir(), 'ctli-fixture-server.pid');

module.exports = async function globalSetup() {
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    stdio: 'inherit',
    detached: true
  });
  fs.writeFileSync(PID_FILE, String(child.pid));
  child.unref();
  // give the servers a moment to start listening
  await new Promise((resolve) => setTimeout(resolve, 300));
};
