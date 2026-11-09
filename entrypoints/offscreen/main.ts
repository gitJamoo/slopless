import { handleEngine } from '@/lib/engine';
import { listen } from '@/lib/messages';

// Content scripts' messages also reach this page; only answer engine requests.
listen((msg) => (msg?.target === 'engine' ? handleEngine(msg) : undefined));
