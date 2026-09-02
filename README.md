# family-schedule

A static, read-only week view of the family schedule: one block per day, a lane
per person, time running right-to-left across the block. Overlapping activities
for the same person stack inside their lane and are flagged as conflicts; an
activity can be clicked to mark it as "not attending", which also removes it
from conflict detection.

The schedule data is private, so the repository holds only an encrypted copy of
it (`schedule.coded`). The page asks for the family key once and remembers it in
the browser's local storage.

## Files

| file               | committed | what it is                                        |
|--------------------|-----------|---------------------------------------------------|
| `index.html`, `styles.css`, `app.js` | yes | the page itself; no build step, no dependencies |
| `schedule.coded`   | yes       | AES-256-GCM ciphertext of `schedule.json`, base64 |
| `schedule.json`    | **no**    | the real schedule — the file you edit             |
| `secret`           | **no**    | the 256-bit key, base64                           |
| `input.csv`        | **no**    | optional CSV source for `schedule.json`           |
| `encode.js`        | yes       | encrypts `schedule.json` into `schedule.coded`    |
| `.githooks/pre-push`| yes      | blocks a push with a stale or leaky data file      |
| `package.json`     | yes       | the `encode` / `parse` scripts; no dependencies   |
| `parse-schedule.js`| yes       | converts a CSV of activities into `schedule.json` |

## Changing the schedule

```sh
$EDITOR schedule.json          # or: npm run parse   (input.csv -> schedule.json)
npm run encode                 # rewrites schedule.coded
git add schedule.coded && git commit -m "update schedule"
```

`npm run encode` picks a fresh random IV every time, so the whole of
`schedule.coded` changes on each run even when the schedule did not — that is
required (an IV must never be reused with the same key), not churn to suppress.

The first `npm run encode` creates `secret` with a fresh random key and prints
it. Keep it — the schedule cannot be opened without it, and nothing can
recover it.

## Viewing it

The page fetches `schedule.coded` from its own directory, which browsers refuse
for pages opened straight from disk, so serve the directory:

```sh
npx serve .                     # or: python3 -m http.server 8000
```

Paste the key from `secret` into the box on first load; it is remembered per
browser.

Decryption uses WebCrypto, which browsers only expose over `https` or on
`localhost`. GitHub Pages serves `https`, so the published page is fine; a page
served over plain `http` from a LAN address is not.

## The pre-push hook

`.githooks/pre-push` refuses a push when `schedule.coded` does not decrypt to
the current `schedule.json` — that is, when the schedule was edited but not
re-encoded — and also when `secret`, `schedule.json` or `input.csv` have somehow
become tracked. Enable it once per clone:

```sh
git config core.hooksPath .githooks
```

A clone that has no `schedule.json` or `secret` cannot check anything, so the
hook says so and lets the push through; only the owner's machine can verify.
The same check on demand: `npm run check`.

## Rotating the key

```sh
rm secret && node encode.js && git commit -am "rotate key"
```

Every viewer then pastes the new key once. Note that the old `schedule.coded`
stays in git history and remains readable with the old key, so rotation limits
future exposure, not past.

## What the encryption does and does not do

`schedule.coded` is public: anyone can download it, and its size and update
times are visible. The contents are AES-256-GCM, so without the key it is not
readable, and a wrong key is reported as a wrong key rather than producing
garbage. But the protection is exactly as good as the handling of the key
itself — it is shared with family members, pasted into browsers, and stored in
their local storage. This is the right level of care for an activity schedule;
it is not a place to put anything genuinely sensitive.
