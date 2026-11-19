import { memo } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const components: Components = {
  a: ({ node: _n, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
  table: ({ node: _n, ...props }) => (
    <div className="md-table"><table {...props} /></div>
  ),
};

/**
 * Assistant markdown. No `rehype-raw`: HTML a bot writes stays text, never DOM. `urlTransform`
 * points a link or image somewhere first (a file's relative image); react-markdown's own check
 * still runs on the result, so a `javascript:` link stays blocked.
 */
export const Markdown = memo(function Markdown({ text, urlTransform }: { text: string; urlTransform?: (href: string) => string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={(url) => defaultUrlTransform(urlTransform ? urlTransform(url) : url)}>{text}</ReactMarkdown>
    </div>
  );
});
