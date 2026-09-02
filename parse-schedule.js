#!/usr/bin/env node
'use strict';

const fs = require('fs');

/**
 * Splits a single CSV line into its raw values, honoring double-quoted
 * fields (with "" as an escaped quote).
 */
function splitLine(line) {
  const values = [];
  let value = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        value += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      values.push(value);
      value = '';
    } else {
      value += c;
    }
  }
  values.push(value);

  return values.map((v) => v.trim());
}

/**
 * Turns CSV text into one object per row:
 *   who, what, where, day (array), startHour, endHour
 */
function parseSchedule(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, i) => {
      const values = splitLine(line);
      if (values.length < 5) {
        throw new Error(`line ${i + 1}: expected 5 values, got ${values.length}: ${line}`);
      }

      const [who, what, where, day, hours] = values;
      const [startHour, endHour] = (what === 'בית-ספר') ? ['0800',hours] : hours.split('-').map((h) => h.trim());
      if (!startHour || !endHour) {
        throw new Error(`line ${i + 1}: bad hour range "${hours}", expected <starthour>-<endhour>`);
      }

      return {
        who,
        what,
        where,
        days: day.split('+').map((d) => d.trim()).filter((d) => d.length > 0),
        startHour,
        endHour,
      };
    });
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node parse-schedule.js <file.csv>');
    process.exit(1);
  }

  const rows = parseSchedule(fs.readFileSync(file, 'utf8'));
  console.log(JSON.stringify(rows, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = { parseSchedule };
