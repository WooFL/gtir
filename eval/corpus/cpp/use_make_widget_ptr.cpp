// useWP declares a local from a smart-pointer-returning factory (`unique_ptr<Widget> makeWidgetPtr()`);
// the return type unwraps to Widget, so the `->` call p->run resolves to Widget::run (not Gadget::run).
void useWP() { auto p = makeWidgetPtr(); p->run(); }
