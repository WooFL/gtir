// useW declares a local from a bare-return factory (`Widget makeWidget()`); the
// return-type index binds `w` to Widget, so w.run resolves to Widget::run (not Gadget::run).
void useW() { auto w = makeWidget(); w.run(); }
