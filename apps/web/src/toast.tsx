import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2 } from 'lucide-react';

type Toast = { id: number; message: string };
const ToastContext = createContext<(message: string) => void>(() => undefined);

/** Short confirmations ("Sent", "Saved") that appear briefly at the bottom and announce themselves. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast>();
  const counter = useRef(0);
  const show = useCallback((message: string) => setToast({ id: ++counter.current, message }), []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast((current) => (current?.id === toast.id ? undefined : current)), 2800);
    return () => clearTimeout(timer);
  }, [toast]);
  return <ToastContext.Provider value={show}>
    {children}
    <div className="fin-toast-region" role="status" aria-live="polite">
      {toast && <div className="fin-toast" key={toast.id}><CheckCircle2 size={18} /> {toast.message}</div>}
    </div>
  </ToastContext.Provider>;
}
export const useToast = () => useContext(ToastContext);
