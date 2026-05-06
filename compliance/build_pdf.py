"""Convert VIPER NIST CSF Policy Guide markdown to PDF."""
from pathlib import Path
from markdown_pdf import MarkdownPdf, Section

HERE = Path(__file__).parent
md_path = HERE / "VIPER_NIST_CSF_Policy_Guide.md"
pdf_path = HERE / "VIPER_NIST_CSF_Policy_Guide.pdf"

md_text = md_path.read_text(encoding="utf-8")

pdf = MarkdownPdf(toc_level=2, optimize=True)

css = """
body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 10.5pt; line-height: 1.45; color: #1a1a1a; }
h1 { color: #0b3d91; border-bottom: 2px solid #0b3d91; padding-bottom: 4px; margin-top: 18px; font-size: 20pt; }
h2 { color: #0b3d91; border-bottom: 1px solid #cbd5e1; padding-bottom: 3px; margin-top: 16px; font-size: 15pt; }
h3 { color: #1e3a8a; margin-top: 14px; font-size: 12.5pt; }
h4 { color: #334155; margin-top: 10px; font-size: 11pt; }
code { background: #f1f5f9; padding: 1px 4px; border-radius: 3px; font-family: 'Consolas', 'Courier New', monospace; font-size: 9.5pt; }
pre { background: #f1f5f9; padding: 8px; border-radius: 4px; overflow-x: auto; font-size: 9pt; }
table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 9.5pt; }
th, td { border: 1px solid #cbd5e1; padding: 5px 7px; text-align: left; vertical-align: top; }
th { background: #e2e8f0; }
blockquote { border-left: 3px solid #0b3d91; padding-left: 10px; color: #475569; margin: 6px 0; }
ul, ol { margin: 4px 0 8px 22px; }
li { margin: 2px 0; }
strong { color: #0b3d91; }
hr { border: none; border-top: 1px solid #cbd5e1; margin: 14px 0; }
"""

pdf.add_section(Section(md_text, toc=True), user_css=css)

pdf.meta["title"] = "VIPER NIST CSF Policy Guide"
pdf.meta["author"] = "Intellect Law Enforcement"
pdf.meta["subject"] = "NIST Cybersecurity Framework Policy Template (aligned to MS-ISAC guide)"

pdf.save(pdf_path)
print(f"Wrote {pdf_path} ({pdf_path.stat().st_size:,} bytes)")
