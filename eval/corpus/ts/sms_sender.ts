import { Sender } from "./sender";

// SmsSender is a second concrete Sender implementer overriding the same send() — the dispatch set
// for a Sender-typed receiver therefore includes both this file and email_sender.ts.
export class SmsSender implements Sender {
  send(): number {
    return 2;
  }
}
