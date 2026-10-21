import { handleAtlasDataRequest } from '../_atlas_data.js';

export function onRequest(context) {
  return handleAtlasDataRequest(context.request, context.env, context.params?.path);
}
