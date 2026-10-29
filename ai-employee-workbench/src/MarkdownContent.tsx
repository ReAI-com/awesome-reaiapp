import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileText } from "lucide-react";
import type { DataRecord } from "../shared/types";

export interface RecordCitation { id: string; version: number }
const citationPattern = /\[记录:([A-Za-z0-9_-]{1,100})\s+v([1-9]\d*)\]/g;
const citationUrlPattern = /^#record:([A-Za-z0-9_-]{1,100}):([1-9]\d*)$/;
type MarkdownNode = { type: string; value?: string; url?: string; children?: MarkdownNode[] };

/** Transform prose only: code, existing links, and images remain literal. */
function remarkRecordCitations() {
  return (tree: MarkdownNode) => {
    function visit(node: MarkdownNode) {
      if (!node.children || ["link", "linkReference", "image", "imageReference", "code", "inlineCode"].includes(node.type)) return;
      node.children = node.children.flatMap(child => {
        if (child.type !== "text" || !child.value) { visit(child); return [child]; }
        const parts: MarkdownNode[] = [];
        let offset = 0;
        for (const match of child.value.matchAll(citationPattern)) {
          if (!Number.isSafeInteger(Number(match[2]))) continue;
          if (match.index! > offset) parts.push({ type: "text", value: child.value.slice(offset, match.index) });
          parts.push({ type: "link", url: `#record:${match[1]}:${match[2]}`, children: [{ type: "text", value: match[0] }] });
          offset = match.index! + match[0].length;
        }
        if (!parts.length) return [child];
        if (offset < child.value.length) parts.push({ type: "text", value: child.value.slice(offset) });
        return parts;
      });
    }
    visit(tree);
  };
}

export function parseRecordCitation(url: string): RecordCitation | undefined {
  const match = citationUrlPattern.exec(url);
  if (!match || !Number.isSafeInteger(Number(match[2]))) return undefined;
  return { id: match[1], version: Number(match[2]) };
}

export function safeMarkdownUrl(url: string) {
  if (parseRecordCitation(url)) return url;
  // No images are loaded; navigation requires an explicit user click and a web/mail URL.
  if (/^https?:\/\//i.test(url) || /^mailto:[^\s]+$/i.test(url)) {
    try { const parsed = new URL(url); if (["http:", "https:", "mailto:"].includes(parsed.protocol) && !parsed.username && !parsed.password) return url; } catch { /* show label only */ }
  }
  return "";
}

function citationLabel(record: DataRecord | undefined, citation: RecordCitation) {
  // A business label is useful only when it belongs to the exact cited revision.
  if (record?.version === citation.version) {
    for (const field of ["transaction_id", "invoice_id", "voucher_no", "document_no", "name"]) {
      const value = record.data[field];
      if (typeof value === "string" && value.trim()) return value.slice(0, 28);
    }
  }
  return citation.id.slice(0, 8);
}

export function MarkdownContent({ content, records = [], onCitation }: {
  content: string;
  records?: DataRecord[];
  onCitation?: (citation: RecordCitation) => void;
}) {
  return <div className="markdown-content">
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkRecordCitations]}
      skipHtml
      urlTransform={safeMarkdownUrl}
      components={{
        a: ({ href, children }) => {
          const citation = parseRecordCitation(href || "");
          if (citation) {
            const record = records.find(item => item.id === citation.id);
            const label = `${citationLabel(record, citation)} · v${citation.version}`;
            return onCitation ? <button type="button" className="record-citation" title={`核对记录 ${citation.id} 的第 ${citation.version} 版`} aria-label={`查看引用 ${label}`} onClick={() => onCitation(citation)}><FileText size={11} aria-hidden="true" />{label}</button> : <span className="record-citation">{label}</span>;
          }
          return href ? <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{children}</a> : <span>{children}</span>;
        },
        img: ({ alt }) => <span className="markdown-image-note">[图片{alt ? `：${alt}` : ""}]</span>,
        table: ({ children }) => <div className="markdown-table-scroll" role="region" aria-label="回答中的表格" tabIndex={0}><table>{children}</table></div>,
        pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
      }}
    >{content}</ReactMarkdown>
  </div>;
}
