import { Sender } from "./sender";

// EmailSender is one concrete Sender implementer; its send() is one of the dispatch targets a call
// on a Sender-typed receiver fans out to.
export class EmailSender implements Sender {
  send(): number {
    return 1;
  }
}
