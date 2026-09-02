#!/usr/bin/env node
'use strict';

/**
 * Encrypts schedule.json into schedule.coded (base64, git-friendly) using the
 * 256-bit key in ./secret. Both ./secret and schedule.json stay out of git;
 * schedule.coded is the only one meant to be committed.
 *
 *   node encode.js            rewrites schedule.coded
 *   node encode.js --check    exits non-zero if schedule.coded is out of date
 */

const fs = require('fs');
const crypto = require('crypto');

const SECRET = 'secret';
const SOURCE = 'schedule.json';
const TARGET = 'schedule.coded';
const IV_LEN = 12;
const TAG_LEN = 16;
const WRAP = 76;

/** Reads ./secret, creating a fresh random key on first run. */
function readKey() {
  if (fs.existsSync(SECRET)) {
    const key = Buffer.from(fs.readFileSync(SECRET, 'utf8').trim(), 'base64');
    if (key.length !== 32) {
      throw new Error(`${SECRET} must hold a base64-encoded 256-bit key (got ${key.length} bytes)`);
    }
    return { key, created: false };
  }

  const key = crypto.randomBytes(32);
  fs.writeFileSync(SECRET, `${key.toString('base64')}\n`, { mode: 0o600 });
  return { key, created: true };
}

/**
 * Entry ids are what the page keys cancellations on, so a missing or reused id
 * is a hard error: nothing gets encoded, and nothing gets pushed.
 */
function validate(entries) {
  if (!Array.isArray(entries)) {
    console.error(`${SOURCE} must contain a JSON array`);
    process.exit(1);
  }

  const problems = [];
  const seen = new Map();

  entries.forEach((entry, i) => {
    const at = `entry #${i + 1}`;
    const id = String(entry && entry.id != null ? entry.id : '').trim();
    if (!id) {
      problems.push(`${at} has no id`);
      return;
    }
    if (seen.has(id)) {
      problems.push(`${at} reuses id "${id}", already used by entry #${seen.get(id)}`);
      return;
    }
    seen.set(id, i + 1);
  });

  if (problems.length) {
    console.error(`${SOURCE} is not valid:`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
}

/** Decrypts schedule.coded back to its plaintext bytes. */
function decode(key, coded) {
  const bytes = Buffer.from(coded.replace(/\s+/g, ''), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, IV_LEN));
  decipher.setAuthTag(bytes.subarray(bytes.length - TAG_LEN));
  return Buffer.concat([
    decipher.update(bytes.subarray(IV_LEN, bytes.length - TAG_LEN)),
    decipher.final(),
  ]);
}

/**
 * Ciphertexts cannot be compared directly (every run draws a fresh IV), so
 * alignment means: schedule.coded decrypts to exactly the current schedule.json.
 */
function check() {
  for (const file of [SECRET, SOURCE, TARGET]) {
    if (!fs.existsSync(file)) {
      console.error(`${TARGET} cannot be verified: ./${file} is missing`);
      process.exit(1);
    }
  }

  const { key } = readKey();
  const source = fs.readFileSync(SOURCE);
  validate(JSON.parse(source.toString('utf8')));
  let decoded;
  try {
    decoded = decode(key, fs.readFileSync(TARGET, 'utf8'));
  } catch {
    console.error(`${TARGET} does not decrypt with ./${SECRET} — run: npm run encode`);
    process.exit(1);
  }

  if (!decoded.equals(source)) {
    console.error(`${TARGET} is out of date with ${SOURCE} — run: npm run encode`);
    process.exit(1);
  }

  console.log(`${TARGET} matches ${SOURCE}`);
}

function main() {
  if (process.argv.includes('--check')) return check();

  const { key, created } = readKey();
  const plain = fs.readFileSync(SOURCE);
  validate(JSON.parse(plain.toString('utf8'))); // fail here rather than in the browser

  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const sealed = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);

  const b64 = Buffer.concat([iv, sealed]).toString('base64')
    .replace(new RegExp(`(.{${WRAP}})`, 'g'), '$1\n');
  fs.writeFileSync(TARGET, `${b64.trimEnd()}\n`);

  if (created) {
    console.log(`נוצר מפתח חדש ב-./${SECRET}:\n\n  ${key.toString('base64')}\n`);
    console.log('שמרו אותו — בלעדיו לא ניתן לפתוח את הלוח. אל תעלו את הקובץ ל-git.\n');
  }
  console.log(`${SOURCE} -> ${TARGET} (${plain.length} bytes plaintext)`);
}

if (require.main === module) main();
