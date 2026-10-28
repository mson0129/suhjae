import assert from 'node:assert/strict';
import {initialWorkspace,validate,addNode,moveNode,removeNode,documentFilename,importMarkdown} from '../web/app/store.js';
const data=initialWorkspace();assert.equal(validate(data),data);
const a=addNode(data,null,'folder'),b=addNode(data,a.id,'folder'),doc=addNode(data,b.id,'document');doc.markdown='한글😀 **기록**';
assert.equal(moveNode(data,a.id,b.id,'inside'),false,'cycle rejected');assert.equal(moveNode(data,b.id,doc.id,'inside'),false,'document cannot contain children');assert.equal(moveNode(data,doc.id,doc.id,'inside'),false);
assert(moveNode(data,doc.id,a.id,'before'));assert.equal(doc.parent,null);assert(data.nodes.indexOf(doc)<data.nodes.indexOf(a));assert(moveNode(data,doc.id,b.id,'inside'));assert.equal(doc.parent,b.id);assert(b.open);
assert(moveNode(data,b.id,null,'inside'));assert.equal(b.parent,null);assert.equal(doc.parent,b.id,'moving folder retains children');
const restored=validate(JSON.parse(JSON.stringify(data)));assert.equal(restored.nodes.find(n=>n.id===doc.id).markdown,'한글😀 **기록**');
data.active=doc.id;removeNode(data,b.id);assert(!data.nodes.some(n=>[b.id,doc.id].includes(n.id)));assert(data.nodes.some(n=>n.id===data.active&&n.type==='document'));
assert.throws(()=>validate({...data,nodes:[{id:'bad',name:'bad',type:'folder',parent:'bad'}]}));
assert.throws(()=>validate({...data,nodes:[{id:'bad',name:'bad',type:'folder',parent:'missing'}]}));
console.log('Workspace hierarchy, ordering, cycle protection, recursive deletion and persistence checks passed.');

assert.equal(documentFilename('회의 기록.md'),'회의 기록.md');assert.equal(documentFilename('NOTES.MD'),'NOTES.MD');assert.equal(documentFilename('회의 기록'),'회의 기록.md');
const imported=initialWorkspace(),original=imported.nodes.find(n=>n.type==='document'),parent=original.parent;
const newDocs=importMarkdown(imported,parent,[{name:original.name,markdown:'새 원문😀\n\n**굵게**'},{name:'둘째.MD',markdown:''},{name:'ignore.txt',markdown:'ignored'}]);
assert.equal(newDocs.length,2);assert.notEqual(newDocs[0].id,original.id);assert.notEqual(newDocs[0].markdown,original.markdown);assert.equal(newDocs[0].parent,parent);assert.equal(imported.active,newDocs[1].id);assert.equal(newDocs[0].markdown,'새 원문😀\n\n**굵게**');validate(JSON.parse(JSON.stringify(imported)));
console.log('Current document filenames and non-destructive multi-file Markdown import verified.');
