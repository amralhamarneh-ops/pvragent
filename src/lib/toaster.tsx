'use client';

import React from 'react';
import { Toaster } from 'sonner';

export default function AppToaster() {
  return <Toaster position="bottom-right" duration={3000} richColors />;
}