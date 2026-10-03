from PySide6.QtGui import QFontDatabase


def build_font_rule() -> str:
    available = set(QFontDatabase.families())
    candidates = ["Pretendard", "Pretendard Variable", "Apple SD Gothic Neo", "Malgun Gothic", "Helvetica Neue"]
    present = [f'"{name}"' for name in candidates if name in available]
    if not present:
        return ""
    stack = ", ".join(present)
    return f"* {{ font-family: {stack}; }}\n"


LIGHT_STYLESHEET = """
#StatusPage, #ReservationPage { background-color: #f8fafc; }

#SummaryBar {
    background-color: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
}
#SummaryItem {
    background-color: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
}
#SummaryItem:hover { background-color: #f1f5f9; }
#SummaryItem[checked="true"] {
    background-color: #f1f5f9;
    border: 1px solid #cbd5e1;
}
#SummaryLabel { color: #64748b; font-size: 13px; }
#SummaryCount { font-size: 16px; font-weight: 600; }
#SummaryCount[tier="urgent"]      { color: #dc2626; }
#SummaryCount[tier="approaching"] { color: #d97706; }
#SummaryCount[tier="waiting"]     { color: #2563eb; }
#SummaryCount[tier="total"]       { color: #1e293b; }

#BookCard, #ReservationCard {
    background-color: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 10px;
}
#BookCard:hover, #ReservationCard:hover { border: 1px solid #cbd5e1; }

#DdayBadge {
    padding: 3px 10px;
    border-radius: 10px;
    font-weight: 600;
    font-size: 12px;
    min-width: 40px;
}
#DdayBadge[tier="urgent"]      { background-color: #fee2e2; color: #dc2626; }
#DdayBadge[tier="approaching"] { background-color: #fef3c7; color: #d97706; }
#DdayBadge[tier="waiting"]     { background-color: #dbeafe; color: #2563eb; }
#DdayBadge[tier="normal"]      { background-color: #d1fae5; color: #059669; }

#CardTitle { font-size: 14px; font-weight: 600; color: #1e293b; }
#CardMeta  { font-size: 12px; color: #64748b; }
#CardStatusIcon { font-size: 14px; }

#FilterChip {
    background-color: #ffffff;
    color: #475569;
    border: 1px solid #e2e8f0;
    border-radius: 14px;
    padding: 5px 14px;
    font-size: 13px;
}
#FilterChip:checked {
    background-color: #0f172a;
    color: #ffffff;
    border: 1px solid #0f172a;
}
#FilterChip:hover { border-color: #94a3b8; }

#RefreshButton {
    background-color: #0f172a;
    color: #ffffff;
    border: none;
    border-radius: 6px;
    padding: 8px 16px;
    font-weight: 500;
}
#RefreshButton:hover { background-color: #1e293b; }
#RefreshButton:disabled { background-color: #94a3b8; }

#ClearFiltersButton {
    background-color: transparent;
    color: #2563eb;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    padding: 6px 16px;
    font-size: 13px;
}
#ClearFiltersButton:hover { background-color: #f1f5f9; border-color: #94a3b8; }

#CardScroll, #CardContainer { background-color: transparent; border: none; }
#LastUpdatedLabel { color: #64748b; font-size: 12px; }
#EmptyMessage { color: #94a3b8; font-size: 14px; padding: 40px 10px 4px 10px; }
"""

DARK_STYLESHEET = """
QWidget { background-color: #0f1115; color: #e2e8f0; }

QTabWidget::pane { border: 1px solid #2a2f38; background-color: #0f1115; }
QTabBar::tab {
    background-color: #1a1d23;
    color: #94a3b8;
    padding: 8px 20px;
    border: 1px solid #2a2f38;
    border-bottom: none;
}
QTabBar::tab:selected { background-color: #0f1115; color: #e2e8f0; }

QLineEdit, QComboBox, QListWidget {
    background-color: #1a1d23;
    color: #e2e8f0;
    border: 1px solid #2a2f38;
    padding: 4px;
    border-radius: 4px;
}
QPushButton {
    background-color: #1a1d23;
    color: #e2e8f0;
    border: 1px solid #2a2f38;
    padding: 6px 14px;
    border-radius: 4px;
}
QPushButton:hover { background-color: #2a2f38; }
QCheckBox, QLabel { color: #e2e8f0; }

#StatusPage, #ReservationPage { background-color: #0f1115; }

#SummaryBar {
    background-color: #1a1d23;
    border: 1px solid #2a2f38;
    border-radius: 8px;
}
#SummaryItem {
    background-color: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
}
#SummaryItem:hover { background-color: #2a2f38; }
#SummaryItem[checked="true"] {
    background-color: #2a2f38;
    border: 1px solid #475569;
}
#SummaryLabel { color: #94a3b8; font-size: 13px; }
#SummaryCount { font-size: 16px; font-weight: 600; }
#SummaryCount[tier="urgent"]      { color: #fca5a5; }
#SummaryCount[tier="approaching"] { color: #fcd34d; }
#SummaryCount[tier="waiting"]     { color: #93c5fd; }
#SummaryCount[tier="total"]       { color: #e2e8f0; }

#BookCard, #ReservationCard {
    background-color: #1a1d23;
    border: 1px solid #2a2f38;
    border-radius: 10px;
}
#BookCard:hover, #ReservationCard:hover { border: 1px solid #475569; }

#DdayBadge {
    padding: 3px 10px;
    border-radius: 10px;
    font-weight: 600;
    font-size: 12px;
    min-width: 40px;
}
#DdayBadge[tier="urgent"]      { background-color: #3b1418; color: #fca5a5; }
#DdayBadge[tier="approaching"] { background-color: #3a2a0a; color: #fcd34d; }
#DdayBadge[tier="waiting"]     { background-color: #102a4c; color: #93c5fd; }
#DdayBadge[tier="normal"]      { background-color: #0f2e24; color: #6ee7b7; }

#CardTitle { font-size: 14px; font-weight: 600; color: #e2e8f0; }
#CardMeta  { font-size: 12px; color: #94a3b8; }
#CardStatusIcon { font-size: 14px; }

#FilterChip {
    background-color: #1a1d23;
    color: #cbd5e1;
    border: 1px solid #2a2f38;
    border-radius: 14px;
    padding: 5px 14px;
    font-size: 13px;
}
#FilterChip:checked {
    background-color: #e2e8f0;
    color: #0f1115;
    border: 1px solid #e2e8f0;
}
#FilterChip:hover { border-color: #475569; }

#RefreshButton {
    background-color: #e2e8f0;
    color: #0f1115;
    border: none;
    border-radius: 6px;
    padding: 8px 16px;
    font-weight: 500;
}
#RefreshButton:hover { background-color: #cbd5e1; }
#RefreshButton:disabled { background-color: #475569; color: #94a3b8; }

#ClearFiltersButton {
    background-color: transparent;
    color: #93c5fd;
    border: 1px solid #2a2f38;
    border-radius: 6px;
    padding: 6px 16px;
    font-size: 13px;
}
#ClearFiltersButton:hover { background-color: #2a2f38; border-color: #475569; }

#CardScroll, #CardContainer { background-color: transparent; border: none; }
#LastUpdatedLabel { color: #94a3b8; font-size: 12px; }
#EmptyMessage { color: #64748b; font-size: 14px; padding: 40px 10px 4px 10px; }

QHeaderView::section {
    background-color: #1a1d23;
    color: #e2e8f0;
    padding: 4px;
    border: 1px solid #2a2f38;
}
"""
