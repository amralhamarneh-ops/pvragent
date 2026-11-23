'use client';

import React from 'react';

interface RequireSignInProps {
  children: React.ReactNode;
  returnTo?: string;
  purpose?: string;
}

/** Sign-in is not required for now, so this renders its children unchanged. */
export default function RequireSignIn({ children }: RequireSignInProps) {
  return <>{children}</>;
}
