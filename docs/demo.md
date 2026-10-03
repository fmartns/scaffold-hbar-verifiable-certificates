# Three-minute demo

Prepared state: `yarn issuer:init` done, `yarn dev` running, HashScan open in a second tab, an empty `.data/`
register is fine. Times are cues, not limits.

| Time | Action | What to say |
| --- | --- | --- |
| 0:00 | Open the console. Point at the issuer panel's DID, credential definition and revocation entries links. | "An academy published its identity and its credential definition on Hedera. Those topics are the registry every verifier reads." |
| 0:15 | **Issue certificate**: Ana Example, Solidity Basics, grade 88. | "Two things happen: the PDF goes to Hedera as an HCS-1 file, then a credential goes into Ana's wallet with the PDF's SHA-256 inside it." |
| 0:35 | **Download PDF**, open it, show the QR code. Open the HCS-1 topic on HashScan: five messages, memo = hash. | "This is the human certificate. It is rebuilt from Hedera and checked against its hash before you get it. It contains no grade." |
| 0:55 | **ana applies** → ENROLLED. Read the card. | "Platform B asked for the course, `grade ≥ 70` and non-revocation now. It received the course and 'true'. It never saw 88, her name or her student id, and it never called the academy." |
| 1:20 | **bob applies** → DENIED. | "Bob has Ana's PDF. A PDF is not a credential: the proof needs Ana's link secret." |
| 1:35 | **Check a downloaded certificate**: Ana's PDF → MATCH / VALID. Edit one byte, check again → MISMATCH. | "The credential commits to the document's hash, so a forged PDF fails even when the credential is fine." |
| 1:55 | **Revoke**. Show the new message on the revocation entries topic in HashScan. | "Revocation is one message on Hedera, signed by the academy's key, with a consensus timestamp." |
| 2:10 | **ana applies** → DENIED. | "Platform B rebuilt the revocation state from that topic. Same answer for every verifier; the academy cannot show a different list to someone else." |
| 2:25 | **Was it valid at…** a time before the revocation → ENROLLED. | "Ask about any past instant: the state at that consensus timestamp is replayed. Valid on Tuesday, revoked today." |
| 2:40 | **Check a downloaded certificate** again → document MATCH, credential REVOKED. | "Two separate facts: the document is genuine, and the certificate it shows is no longer valid." |
| (2:45) | Optional, on a throwaway data directory: **Withdraw (authority)**, then a fresh certificate → DENIED "not accredited". | "Who may certify is public too: an accreditation authority's contract on Hedera. Platform B reads it before every decision." |
| 2:50 | Close on the README table "Why AnonCreds / Why Hedera / Why HCS-1 / Why the hash". | "`npm create scaffold-hbar` and you start from here." |
