import type { ComponentPropsWithRef, ReactNode } from 'react';

export const cn = (...classes: (string | false | undefined | null)[]) => classes.filter(Boolean).join(' ');

type ButtonProps = ComponentPropsWithRef<'button'> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'md' | 'lg';
};

const variants = {
  primary: 'bg-slate-900 text-white hover:bg-slate-800',
  secondary: 'bg-white text-slate-900 border border-slate-300 hover:bg-slate-100',
  ghost: 'text-slate-600 hover:bg-slate-200',
  danger: 'bg-white text-red-600 border border-red-200 hover:bg-red-50',
};

export function Button({ variant = 'primary', size = 'md', className, ...props }: ButtonProps) {
  return (
    <button
      {...props}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900',
        'disabled:pointer-events-none disabled:opacity-50',
        size === 'lg' ? 'h-14 px-6 text-lg' : 'h-10 px-4 text-sm',
        variants[variant],
        className
      )}
    />
  );
}

export function Input({ className, ...props }: ComponentPropsWithRef<'input'>) {
  return (
    <input
      {...props}
      className={cn(
        'w-full rounded-xl border border-slate-300 bg-white px-4 text-slate-900 placeholder:text-slate-400',
        'focus:border-slate-900 focus:outline-none',
        className
      )}
    />
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-2xl border border-slate-200 bg-white p-5 shadow-sm', className)}>{children}</div>
  );
}

export function Progress({ percent }: { percent: number }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
      <div
        className="h-full rounded-full bg-emerald-500 transition-all duration-300"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

export function Badge({ completed }: { completed: boolean }) {
  return (
    <span
      className={cn(
        'rounded-full px-2.5 py-1 text-xs font-medium',
        completed ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
      )}
    >
      {completed ? 'Completado' : 'Pendiente'}
    </span>
  );
}
