import { useEffect, useRef, useState } from 'react';
import Convert from 'ansi-to-html';

const convert = new Convert({ fg: '#e0e0e0', bg: '#0d1117', newline: true, escapeXML: true });

interface Props {
  content?: string;
  liveUrl?: string;
  className?: string;
}

export default function AnsiOutput({ content, liveUrl, className }: Props) {
  const ref = useRef<HTMLPreElement>(null);
  const [liveContent, setLiveContent] = useState('');
  const [streaming, setStreaming] = useState(false);

  useEffect(() => {
    if (!liveUrl) return;
    setStreaming(true);
    const es = new EventSource(liveUrl);
    es.onmessage = (e) => {
      try {
        const chunk = JSON.parse(e.data) as string;
        setLiveContent((prev) => prev + chunk);
      } catch { /* ignore */ }
    };
    es.addEventListener('done', () => { setStreaming(false); es.close(); });
    es.onerror = () => { setStreaming(false); es.close(); };
    return () => es.close();
  }, [liveUrl]);

  const text = liveUrl ? liveContent : (content ?? '');

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text]);

  return (
    <div className={`relative ${className ?? ''}`}>
      <pre
        ref={ref}
        className="bg-rc-code text-rc-text font-mono text-xs p-3 overflow-auto whitespace-pre-wrap break-words h-full"
        dangerouslySetInnerHTML={{ __html: convert.toHtml(text) }}
      />
      {streaming && (
        <span className="absolute bottom-2 right-2 w-2 h-4 bg-rc-accent animate-pulse rounded-sm" />
      )}
    </div>
  );
}
