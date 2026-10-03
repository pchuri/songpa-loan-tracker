import asyncio
import sys
from pathlib import Path

from PySide6.QtWidgets import QApplication
from qasync import QEventLoop


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


from src.main_window import MainWindow  # noqa: E402


def main():
    app = QApplication(sys.argv)
    loop = QEventLoop(app)
    asyncio.set_event_loop(loop)

    window = MainWindow(loop)
    window.show()

    with loop:
        loop.run_forever()


if __name__ == "__main__":
    main()
