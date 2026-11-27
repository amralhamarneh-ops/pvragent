"""Bounded-memory ASCII DXF block inventory; no asset quantity certification."""
import sys,json,collections,re
counts=collections.Counter(); inserts=collections.Counter(); texts=[]; section=''; block=''; typ=''; tags={}; header={}; variable=''; xrefs=[]
def flush():
 global block
 if typ=='BLOCK':
  block=tags.get(2,'');
  if int(tags.get(70,'0')) & 12:xrefs.append({'name':block,'path':tags.get(1,'')})
 elif typ=='ENDBLK':block=''
 elif section in ('BLOCKS','ENTITIES'):
  if tags.get(67,'0')=='1' or block.upper().startswith('*PAPER_SPACE'):return
  counts[typ]+=1
  if typ=='INSERT':inserts[(block or '*MODEL_SPACE',tags.get(2,''),tags.get(8,''))]+=1
  if typ in ('TEXT','MTEXT','ATTRIB','ATTDEF') and len(texts)<20000:
   t=tags.get(1,'')
   if re.search(r'RVD|VMS|CCTV|TTD|ISC|fiber|fibre|96.core',t,re.I):texts.append({'block':block,'layer':tags.get(8,''),'text':t,'handle':tags.get(5,'')})
with open(sys.argv[1],encoding='utf8',errors='replace') as f:
 while True:
  a=f.readline()
  if not a:break
  b=f.readline().strip()
  try:c=int(a)
  except ValueError:continue
  if c==0:
   flush();typ=b;tags={}
   if b=='ENDSEC':section=''
  else:
   if typ=='SECTION' and c==2:section=b
   if section=='HEADER':
    if c==9:variable=b
    elif variable=='$INSUNITS' and c==70:header['insunits']=int(b)
   if c in (1,2,5,8,67,70):tags[c]=b
flush()
out={'file':sys.argv[1],'header':header,'entityTypes':dict(counts),'inserts':[{'container':k[0],'name':k[1],'layer':k[2],'count':v} for k,v in inserts.items()],'texts':texts,'xrefDefinitions':xrefs,'complete':False,'limitation':'Block-definition inventory, not expanded installed assets. No independent quantities certified.'}
with open(sys.argv[2],'w') as f:json.dump(out,f)
print(json.dumps({'types':dict(counts),'insertGroups':len(inserts),'xrefs':len(xrefs),'texts':len(texts)}))
