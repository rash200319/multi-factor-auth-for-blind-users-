# Changes: aligning the implementation with the design PDF

Changes made after checking the code against `computer_security.pdf`.

## Security fixes

- **Step-up code is now typed from memory (PDF §6.2 step 7b).** Before, the app spoke a brand-new code at step-up time and the user typed it back straight away, so anyone with the device and fingerprint passed. Now the user enters the code they memorised last time, and the server will not speak a new code until step-up has succeeded.
- **No headphones, no spoken code (PDF §6.2 step 7b.i).** The server refuses to verify the spoken code without a confirmed private audio route, and checks this before the old code is used up. The user is directed to the security key instead.
- **New code issued on every successful step-up (PDF §7.1).** The next code is spoken straight away and the user types it back to confirm they heard it.
- **Fixed a bug:** typing back the new code after step-up always failed with a 401 error.
- **Notification on every step-up (PDF §7.4).** An email goes out whenever a step-up succeeds, by spoken code or security key.
- **Clone detection on the security key step-up (PDF §10).** The security key path now checks the authenticator's counter, as normal login already did.

## Code format

- **Step-up codes are 3 words (~38.8 bits)** instead of 2 (PDF §7.2).
- Removed the 4 hyphenated words (`t-shirt`, `yo-yo`, …) from the word list, since the hyphen separates the words in a code.

## Recovery codes

- **Enrolment finishes only after the user types one recovery code back** (PDF §9.2). New endpoint: `POST /recovery/codes/confirm`.
- Added **Download as text file** and **Copy to clipboard** buttons (PDF §9.2 delivery channels).
- Added **Read my recovery codes aloud**, only through headphones and using the same rule as the spoken step-up code. The PDF does not list audio as a recovery-code channel, so this is an addition to the design.

## Accessibility

- **Removed the "I am wearing headphones" checkboxes.** Each button that speaks a code now says it in its label, e.g. "I'm wearing headphones — verify code", so it takes one keypress instead of finding and ticking a checkbox first.
- If a spoken code is refused, keyboard focus moves straight to "Use my security key instead".
- Fixed error messages that never appeared, so "that code didn't match" is now announced correctly.

## Docs and tests

- Readme and docs updated to match the PDF: recovery codes are 4 words each, 8 per set; the first code comes after the security key, not after the phone; the step-up flow is described correctly; the PDF filename is correct.
- Added 3 unit tests. **45/45 passing.**

## Still to do

- Try the new flows in a browser with real authenticators and a screen reader (NVDA/JAWS).
- `server/.env.test` has a `SESSION_SECRET` that is not 32 bytes, so the server won't start with it. The unit tests are unaffected.
- Nothing has been committed yet.
