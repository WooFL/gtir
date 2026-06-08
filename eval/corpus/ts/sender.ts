// Sender is the dispatch interface: every concrete sender implements send(), and a call on a
// Sender-typed receiver fans out to all in-repo implementers (EmailSender, SmsSender) rather than
// binding to one — the TS analogue of a C++ virtual base or a Go interface.
export interface Sender {
  send(): number;
}
