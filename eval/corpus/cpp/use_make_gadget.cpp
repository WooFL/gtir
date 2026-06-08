// useG declares a local from a trailing-return factory (`auto makeGadget() -> Gadget`);
// the return-type index binds `g` to Gadget, so g.run resolves to Gadget::run (not Widget::run).
void useG() { auto g = makeGadget(); g.run(); }
