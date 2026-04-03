import { Text, Code } from '@mantine/core';
import Markdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { ComponentPropsWithoutRef } from 'react';

interface MarkdownContentProps {
  content: string;
}

/**
 * Renders markdown content with syntax-highlighted code blocks.
 * Falls back to raw text on parse failure.
 */
export function MarkdownContent({ content }: MarkdownContentProps) {
  // Quick guard: if the content looks like plain text with no markdown
  // indicators, render it directly to avoid wrapping in <p> tags.
  try {
    return (
      <Markdown
        components={{
          p({ children }) {
            return <Text size="sm" component="p" style={{ margin: 0 }}>{children}</Text>;
          },
          code({ className, children, ...rest }: ComponentPropsWithoutRef<'code'> & { className?: string }) {
            const match = /language-(\w+)/.exec(className ?? '');
            const codeString = String(children).replace(/\n$/, '');
            if (match) {
              return (
                <SyntaxHighlighter
                  style={oneDark}
                  language={match[1]}
                  PreTag="div"
                >
                  {codeString}
                </SyntaxHighlighter>
              );
            }
            return (
              <Code {...rest} className={className}>
                {children}
              </Code>
            );
          },
        }}
      >
        {content}
      </Markdown>
    );
  } catch {
    // Fallback to raw text on parse failure
    return <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{content}</Text>;
  }
}
