const crypto = require('crypto');
const express = require('express');
const { z } = require('zod');
const requireAuth = require('../middleware/auth');
const { createServiceClient } = require('../lib/supabase');
const { getLeadImportQueue, createQueueJobId } = require('../lib/redis');
const { getOrCreateWorkspace, findExistingLead, normalizeLead, upsertLeadWithContext } = require('./leads');

const router = express.Router();
router.use(requireAuth);
const fileSchema = z.object({ filename:z.string().trim().min(1).max(180), mime_type:z.enum(['image/png','image/jpeg','image/webp']), size_bytes:z.number().int().positive().max(10*1024*1024), content_base64:z.string().min(1) });
const uploadSchema = z.object({ files:z.array(fileSchema).min(1).max(20) });
const editable = ['full_name','company_name','title','email','phone','location','external_id','company_domain','context_summary','safe_facts','sensitive_facts'];

router.post('/imports', async (req,res) => {
  const parsed=uploadSchema.safeParse(req.body||{});
  if(!parsed.success) return res.status(400).json({error:'Upload 1–20 PNG, JPEG, or WebP documents, up to 10 MB each.'});
  const total=parsed.data.files.reduce((n,f)=>n+f.size_bytes,0);
  if(total>18*1024*1024) return res.status(400).json({error:'One document batch cannot exceed 18 MB.'});
  const service=createServiceClient();
  if(!service) return res.status(500).json({error:'Document storage is not configured'});
  let record; let error;
  try {
    const workspace=await getOrCreateWorkspace(req.supabase,req.user);
    ({data:record,error}=await req.supabase.from('document_imports').insert({workspace_id:workspace.id,file_count:parsed.data.files.length,created_by:req.user.id}).select('*').single());
    if(error) throw error;
    const files=[];
    for(const item of parsed.data.files){
      const buffer=Buffer.from(item.content_base64,'base64');
      if(buffer.length!==item.size_bytes) throw new Error(`Could not verify ${item.filename}`);
      const safe=item.filename.replace(/[^a-zA-Z0-9._-]+/g,'-');
      const path=`${workspace.id}/${record.id}/${crypto.randomUUID()}-${safe}`;
      const {error:uploadError}=await service.storage.from('lead-documents').upload(path,buffer,{contentType:item.mime_type,upsert:false});
      if(uploadError) throw uploadError;
      const {data:file,error:fileError}=await req.supabase.from('document_import_files').insert({import_id:record.id,workspace_id:workspace.id,filename:item.filename,mime_type:item.mime_type,size_bytes:buffer.length,storage_path:path}).select('*').single();
      if(fileError) throw fileError;
      files.push(file);
    }
    await getLeadImportQueue().add('documents',{importId:record.id,workspaceId:workspace.id,userId:req.user.id,userEmail:req.user.email||null},{jobId:createQueueJobId('documents',record.id)});
    return res.status(202).json({documentImport:record,files});
  } catch(error){
    if(record?.id) await req.supabase.from('document_imports').update({status:'failed',error_message:error.message,completed_at:new Date().toISOString()}).eq('id',record.id);
    return res.status(500).json({error:error.message||'Failed to upload documents'});
  }
});

router.get('/imports/:id',async(req,res)=>{
  try{
    const workspace=await getOrCreateWorkspace(req.supabase,req.user);
    const {data,error}=await req.supabase.from('document_imports').select('*, document_import_files(*), document_lead_candidates(*)').eq('workspace_id',workspace.id).eq('id',req.params.id).maybeSingle();
    if(error) throw error;if(!data)return res.status(404).json({error:'Document import not found'});return res.json({documentImport:data});
  }catch(error){return res.status(500).json({error:error.message||'Failed to load document import'});}
});

router.post('/imports/:id/confirm',async(req,res)=>{
  try{
    const workspace=await getOrCreateWorkspace(req.supabase,req.user);
    const decisions=Array.isArray(req.body.candidates)?req.body.candidates:[];
    const {data:candidates,error}=await req.supabase.from('document_lead_candidates').select('*').eq('workspace_id',workspace.id).eq('import_id',req.params.id).eq('status','review');
    if(error)throw error;
    const byId=new Map(decisions.map(d=>[d.id,d]));const imported=[];
    for(const candidate of candidates||[]){const decision=byId.get(candidate.id);if(!decision||decision.action==='reject'){await req.supabase.from('document_lead_candidates').update({status:'rejected',reviewed_at:new Date().toISOString()}).eq('id',candidate.id);continue;}
      const patch=Object.fromEntries(editable.filter(k=>decision.data?.[k]!==undefined).map(k=>[k,decision.data[k]]));
      for (const conflict of candidate.conflicts || []) if (decision.data?.conflict_resolutions?.[conflict.field] !== 'extracted') patch[conflict.field]=conflict.existing;
      const input={...candidate.extracted_data,...patch,notes_summary:patch.context_summary||candidate.extracted_data.context_summary,raw_data:{document_import_id:req.params.id,document_file_id:candidate.file_id,document_context:{safe_facts:patch.safe_facts||candidate.extracted_data.safe_facts||[],sensitive_facts:patch.sensitive_facts||candidate.extracted_data.sensitive_facts||[]}}};
      const result=await upsertLeadWithContext(req.supabase,req.user,workspace,input,null,'manual');if(result.skipped)throw new Error(result.reason);
      const evidence=(candidate.extracted_data.personalization_profile?.email_context||[]).filter(item=>!(candidate.extracted_data.sensitive_facts||[]).some(s=>s.fact===item.fact));
      const personalization_profile={source:'uploaded_document',personalization_score:Math.min(100,evidence.length*20),source_fields_used:['uploaded_document'],email_context:evidence,evidence};
      const {data:lead,error:profileError}=await req.supabase.from('leads').update({personalization_profile}).eq('workspace_id',workspace.id).eq('id',result.lead.id).select('*').single();if(profileError)throw profileError;imported.push(lead);
      await req.supabase.from('document_lead_candidates').update({status:'imported',reviewed_data:patch,lead_id:result.lead.id,reviewed_at:new Date().toISOString()}).eq('id',candidate.id);
    }
    await req.supabase.from('document_imports').update({status:'completed',completed_at:new Date().toISOString()}).eq('workspace_id',workspace.id).eq('id',req.params.id);
    return res.json({leads:imported});
  }catch(error){return res.status(500).json({error:error.message||'Failed to confirm document leads'});}
});

module.exports=router;
