#include <memory>

struct Widget {
  void run() {}
};

Widget makeWidget() { return Widget(); }
std::unique_ptr<Widget> makeWidgetPtr() { return std::make_unique<Widget>(); }
