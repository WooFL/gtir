import { Sender } from "./sender";

// dispatchSend calls send() on a Sender-typed parameter. The receiver is the interface, so the call
// cannot resolve to a single concrete file — it dispatches to every implementer (EmailSender,
// SmsSender). This is the receiver that exercises the TS dispatch tier.
export function dispatchSend(s: Sender): number {
  return s.send();
}
