import { useState, useEffect, useCallback } from 'react';

interface ToastItem {
  id: number;
  message: string;
  type: 'error' | 'success' | 'info';
}

let toastId = 0;
let addToastGlobal: ((message: string, type?: 'error' | 'success' | 'info') => void) | null = null;

export function showToast(message: string, type: 'error' | 'success' | 'info' = 'error') {
  addToastGlobal?.(message, type);
}

export default function ToastContainer() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const addToast = useCallback((message: string, type: 'error' | 'success' | 'info' = 'error') => {
    const id = ++toastId;
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000);
  }, []);

  useEffect(() => {
    addToastGlobal = addToast;
    return () => { addToastGlobal = null; };
  }, [addToast]);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map(t => (
        <div
          key={t.id}
          className={`px-4 py-3 rounded-lg shadow-lg text-sm animate-[slideIn_0.2s_ease-out] ${
            t.type === 'error' ? 'bg-red-900/90 text-red-100 border border-red-700' :
            t.type === 'success' ? 'bg-green-900/90 text-green-100 border border-green-700' :
            'bg-gray-800/90 text-gray-100 border border-gray-600'
          }`}
          onClick={() => setToasts(prev => prev.filter(x => x.id !== t.id))}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
