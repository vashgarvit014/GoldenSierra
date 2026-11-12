'use client';

import { Fragment, useMemo } from 'react';
import type { Citation } from '@/types/chat';

/**
 * A deliberately small Markdown renderer for assistant answers.
 *
 * Written rather than imported because the answer format is narrow and known
 * — headings, bold, lists, links, and inline [1] citation markers — and
 * because rendering model output with a general-purpose HTML pipeline means
 * accepting a sanitisation problem we do not otherwise have. Nothing here ever
 * produces raw HTML: every node is a React element built from parsed text, so
 * markup inside a model response is displayed, never executed.
 */

type Props = {
  content: string;
  citations?: Citation[];
  onCitationClick?: (id: number) => void;
};

export function Markdown({ content, citations = [], onCitationClick }: Props) {
  const blocks = useMemo(() => parseBlocks(content), [content]);

  return (
    <div className="answer-prose">
      {blocks.map((block, i) => {
        switch (block.type) {
          case 'heading':
            return (
              <h3 key={i}>
                <Inline text={block.text} citations={citations} onCitationClick={onCitationClick} />
              </h3>
            );
          case 'ul':
            return (
              <ul key={i}>
                {block.items.map((item, j) => (
                  <li key={j}>
                    <Inline text={item} citations={citations} onCitationClick={onCitationClick} />
                  </li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={i}>
                {block.items.map((item, j) => (
                  <li key={j}>
                    <Inline text={item} citations={citations} onCitationClick={onCitationClick} />
                  </li>
                ))}
              </ol>
            );
          default:
            return (
              <p key={i}>
                <Inline text={block.text} citations={citations} onCitationClick={onCitationClick} />
              </p>
            );
        }
      })}
    </div>
  );
}

type Block =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] };

function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ type: 'paragraph', text: paragraph.join(' ').trim() });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list?.items.length) {
      blocks.push(list.ordered ? { type: 'ol', items: list.items } : { type: 'ul', items: list.items });
    }
    list = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = /^#{1,6}\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'heading', text: heading[1]! });
      continue;
    }

    // A whole line of bold text is how the model renders a section label.
    const boldHeading = /^\*\*(.+?)\*\*:?$/.exec(trimmed);
    if (boldHeading) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'heading', text: boldHeading[1]! });
      continue;
    }

    const ordered = /^(\d+)[.)]\s+(.*)$/.exec(trimmed);
    if (ordered) {
      flushParagraph();
      if (!list?.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(ordered[2]!);
      continue;
    }

    const unordered = /^[-*•]\s+(.*)$/.exec(trimmed);
    if (unordered) {
      flushParagraph();
      if (list && !list.ordered) {
        list.items.push(unordered[1]!);
      } else {
        flushList();
        list = { ordered: false, items: [unordered[1]!] };
      }
      continue;
    }

    flushList();
    paragraph.push(trimmed);
  }

  flushParagraph();
  flushList();
  return blocks;
}

/** Inline parsing: bold, italic, links, and citation markers. */
function Inline({
  text,
  citations,
  onCitationClick,
}: {
  text: string;
  citations: Citation[];
  onCitationClick?: (id: number) => void;
}) {
  const nodes = useMemo(() => parseInline(text), [text]);

  return (
    <>
      {nodes.map((node, i) => {
        switch (node.type) {
          case 'bold':
            return <strong key={i}>{node.text}</strong>;
          case 'italic':
            return <em key={i}>{node.text}</em>;
          case 'link':
            return (
              <a key={i} href={node.href} target="_blank" rel="noopener noreferrer nofollow">
                {node.text}
              </a>
            );
          case 'citation': {
            const citation = citations.find((c) => c.id === node.id);
            return (
              <button
                key={i}
                type="button"
                onClick={() => onCitationClick?.(node.id)}
                title={citation ? `Source: ${citation.title}` : `Source ${node.id}`}
                aria-label={citation ? `Source ${node.id}: ${citation.title}` : `Source ${node.id}`}
                className="mx-0.5 inline-flex h-[1.15em] min-w-[1.15em] items-center justify-center rounded bg-sierra-100 px-1 align-super text-[0.65em] font-semibold text-sierra-800 hover:bg-sierra-200 dark:bg-sierra-800 dark:text-sierra-100"
              >
                {node.id}
              </button>
            );
          }
          default:
            return <Fragment key={i}>{node.text}</Fragment>;
        }
      })}
    </>
  );
}

type InlineNode =
  | { type: 'text'; text: string }
  | { type: 'bold'; text: string }
  | { type: 'italic'; text: string }
  | { type: 'link'; text: string; href: string }
  | { type: 'citation'; id: number };

function parseInline(input: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  // Order matters: links before bold, so a bolded link is not split wrongly.
  const pattern =
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|(?<![\w*])\*([^*\n]+)\*(?![\w*])|\[(\d+(?:\s*,\s*\d+)*)\]|(https?:\/\/[^\s<>)\]]+)/g;

  let last = 0;
  for (const match of input.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push({ type: 'text', text: input.slice(last, index) });

    const [whole, linkText, linkHref, bold, italic, citationGroup, bareUrl] = match;

    if (linkText && linkHref) {
      nodes.push({ type: 'link', text: linkText, href: safeHref(linkHref) });
    } else if (bold) {
      nodes.push({ type: 'bold', text: bold });
    } else if (italic) {
      nodes.push({ type: 'italic', text: italic });
    } else if (citationGroup) {
      for (const part of citationGroup.split(',')) {
        const id = Number(part.trim());
        if (Number.isInteger(id)) nodes.push({ type: 'citation', id });
      }
    } else if (bareUrl) {
      const href = bareUrl.replace(/[.,;)]+$/, '');
      nodes.push({ type: 'link', text: href.replace(/^https?:\/\//, ''), href: safeHref(href) });
    }

    last = index + whole.length;
  }

  if (last < input.length) nodes.push({ type: 'text', text: input.slice(last) });
  return nodes;
}

/** Only http(s) survives — blocks javascript: and data: URLs outright. */
function safeHref(href: string): string {
  return /^https?:\/\//i.test(href) ? href : '#';
}
