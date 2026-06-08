// Gadget owns a `run` method that collides by name with Widget::run.
// makeGadget is a trailing-return factory (`auto … -> Gadget`); its return type
// is what pins `auto g = makeGadget(); g.run()` to Gadget rather than Widget.
struct Gadget {
  void run() {}
};

auto makeGadget() -> Gadget { return Gadget(); }
