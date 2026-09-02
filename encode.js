#!/usr/bin/env node
'use strict';

/**
 * Encrypts schedule.json into schedule.coded (base64, git-friendly) using the
 * 256-bit key in ./secret. Both ./secret and schedule.json stay out of git;
 * schedule.coded is the only one meant to be committed.
 *
 *   node encode.js
 */

const fs = require('fs');
const crypto = require('crypto');

const SECRET = 'secret';
const SOURCE = 'schedule.json';
const TARGET = 'schedule.coded';
const IV_LEN = 12;
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

function main() {
  const { key, created } = readKey();
  const plain = fs.readFileSync(SOURCE);
  JSON.parse(plain.toString('utf8')); // fail here rather than in the browser

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
