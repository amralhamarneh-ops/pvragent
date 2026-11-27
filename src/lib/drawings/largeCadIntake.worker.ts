import { inventoryCadFile, type CadScanReply } from './largeCadIntake';

const output = (message: CadScanReply) => self.postMessage(message);
self.onmessage = async (message: MessageEvent<Blob>) => {
  try {
    if (!(message.data instanceof Blob)) throw new Error('No readable file was selected.');
    output({ type:'result', inventory:await inventoryCadFile(message.data, loaded=>output({type:'progress',loaded})) });
  } catch (e) {
    output({type:'error',message:e instanceof Error ? e.message : 'The drawing inventory could not be read.'});
  }
};
