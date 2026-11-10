/** Display currency. Override at build time with VITE_CURRENCY. */
export const CURRENCY: string = (import.meta.env.VITE_CURRENCY as string | undefined) ?? 'KES'
