import { Component, type ReactNode } from 'react';
import { Text, Code } from '@mantine/core';
import Markdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { ComponentPropsWithoutRef } from 'react';

interface MarkdownContentProps {
  content: string;
}

/** ErrorBoundary that catches react-markdown render errors and shows raw text. */
interface EBProps {
  fallback: ReactNode;
  children: ReactNode;
}
interface EBState {
  hasError: boolean;
}

class MarkdownErrorBoundary extends Component<EBProps, EBState> {
  constructor(props: EBProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): EBState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown): void {
    console.error('MarkdownContent render failure:', error);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

/**
 * Renders markdown content with syntax-highlighted code blocks.
 * Falls back to raw text on render failure via ErrorBoundary.
 * Sanitizes links and images to prevent javascript: URI XSS.
 */
export function MarkdownContent({ content }: MarkdownContentProps) {
  return (
    <MarkdownErrorBoundary
      fallback={<Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{content}</Text>}
    >
      <Markdown
        components={{
          p({ children }) {
            return <Text size="sm" component="p" style={{ margin: 0 }}>{children}</Text>;
          },
          a({ href, children }) {
            const safe = href && /^(https?:|mailto:|#)/i.test(href);
            if (!safe) return <>{children}</>;
            return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
          },
          img({ src, alt, title }) {
            const safe = src && /^https?:/i.test(src);
            if (!safe) return null;
            return <img src={src} alt={alt} title={title} />;
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
    </MarkdownErrorBoundary>
  );
}
