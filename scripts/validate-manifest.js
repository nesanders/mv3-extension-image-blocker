#!/usr/bin/env node
// Cheap, fast manifest validation that runs before the test jobs so a
// broken manifest.json fails CI immediately instead of after a full
// browser install. `web-ext lint` targets Firefox's MV3 conventions
// (background.scripts, a required browser_specific_settings.gecko.id) and
// reports false-positive errors for a Chromium-only extension like this
// one that uses background.service_worker - so this script checks the
// things that actually matter here: valid JSON, the fields Chromium
// requires, and that every file the manifest references actually exists.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failed = false;

function fail(message) {
  console.error(`✗ ${message}`);
  failed = true;
}

function ok(message) {
  console.log(`✓ ${message}`);
}

function readJson(relPath) {
  const full = path.join(ROOT, relPath);
  if (!fs.existsSync(full)) {
    fail(`${relPath} does not exist`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (e) {
    fail(`${relPath} is not valid JSON: ${e.message}`);
    return null;
  }
}

function requireFile(relPath, context) {
  if (!fs.existsSync(path.join(ROOT, relPath))) {
    fail(`${context} references "${relPath}", which does not exist`);
  } else {
    ok(`${relPath} exists (${context})`);
  }
}

const manifest = readJson('manifest.json');
if (manifest) {
  if (manifest.manifest_version !== 3) {
    fail(`manifest_version must be 3, got ${manifest.manifest_version}`);
  } else {
    ok('manifest_version is 3');
  }

  if (!manifest.background || !manifest.background.service_worker) {
    fail('background.service_worker is required');
  } else {
    requireFile(manifest.background.service_worker, 'background.service_worker');
  }

  if (!Array.isArray(manifest.content_scripts) || manifest.content_scripts.length === 0) {
    fail('content_scripts must be a non-empty array');
  } else {
    manifest.content_scripts.forEach((entry, i) => {
      (entry.js || []).forEach((f) => requireFile(f, `content_scripts[${i}].js`));
      (entry.css || []).forEach((f) => requireFile(f, `content_scripts[${i}].css`));
    });
  }

  const rulesets = manifest.declarative_net_request && manifest.declarative_net_request.rule_resources;
  if (!Array.isArray(rulesets) || rulesets.length === 0) {
    fail('declarative_net_request.rule_resources must be a non-empty array');
  } else {
    rulesets.forEach((rs) => {
      requireFile(rs.path, `declarative_net_request.rule_resources (${rs.id})`);
      const rules = readJson(rs.path);
      if (Array.isArray(rules)) {
        rules.forEach((rule, i) => {
          if (typeof rule.id !== 'number') fail(`${rs.path}[${i}] is missing a numeric id`);
          if (!rule.action || !rule.action.type) fail(`${rs.path}[${i}] is missing action.type`);
          if (!rule.condition) fail(`${rs.path}[${i}] is missing condition`);
        });
        if (!failed) ok(`${rs.path} contains ${rules.length} well-formed rule(s)`);
      }
    });
  }

  if (manifest.options_page) requireFile(manifest.options_page, 'options_page');
  if (manifest.action && manifest.action.default_popup) {
    requireFile(manifest.action.default_popup, 'action.default_popup');
  }
  if (manifest.icons) {
    Object.values(manifest.icons).forEach((iconPath) => requireFile(iconPath, 'icons'));
  }

  const perms = manifest.permissions || [];
  ['declarativeNetRequest', 'storage'].forEach((required) => {
    if (!perms.includes(required)) fail(`permissions must include "${required}"`);
    else ok(`permissions includes "${required}"`);
  });
}

if (failed) {
  console.error('\nManifest validation failed.');
  process.exit(1);
} else {
  console.log('\nManifest validation passed.');
}
