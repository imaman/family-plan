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
| `parse-schedule.js`| yes       | converts a CSV of activities into `schedule.json` |

## Changing the schedule

```sh
$EDITOR schedule.json          # or: node parse-schedule.js input.csv > schedule.json
node encode.js                 # rewrites schedule.coded
git add schedule.coded && git commit -m "update schedule"
```

The first `node encode.js` creates `secret` with a fresh random key and prints
it. Keep it — the schedule cannot be opened without it, and nothing can
recover it.

## Viewing it

`fetch` is blocked for pages opened straight from disk, so serve the directory:

```sh
python3 -m http.server 8000     # then open http://localhost:8000
```

Paste the key from `secret` into the box on first load. (Opening the page from
`file://` also works — it offers a file picker for `schedule.coded` instead.)

Decryption uses WebCrypto, which browsers only expose over `https` or on
`localhost`. GitHub Pages serves `https`, so the published page is fine; a page
served over plain `http` from a LAN address is not.

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
