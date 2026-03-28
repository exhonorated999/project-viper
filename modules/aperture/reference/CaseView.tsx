import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import AttachmentViewer from "../components/AttachmentViewer";

interface Email {
  id: number;
  subject: string;
  from: string;
  to: string[];
  date: string;
  body_text?: string;
  body_html?: string;
  flagged: boolean;
  headers: Array<{ key: string; value: string }>;
  attachments: Array<{
    id: number;
    filename: string;
    mime_type: string;
    size: number;
    flagged: boolean;
    content_id?: string;
    is_inline: boolean;
    file_path?: string;
  }>;
  originating_ip?: {
    ip_address: string;
    classification: string;
    confidence: number;
  };
}

interface IpGeoInfo {
  ip: string;
  country?: string;
  country_code?: string;
  region?: string;
  city?: string;
  zip?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
  isp?: string;
  org?: string;
  asn?: string;
}

interface Note {
  id: number;
  email_id?: number;
  attachment_id?: number;
  content: string;
  created_at: string;
  updated_at: string;
}

function CaseView() {
  const { caseId } = useParams();
  const navigate = useNavigate();
  const [caseName, setCaseName] = useState<string>("");
  const [emails, setEmails] = useState<Email[]>([]);
  const [selectedEmail, setSelectedEmail] = useState<Email | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingEmails, setLoadingEmails] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showHeaders, setShowHeaders] = useState(false);
  const [ipGeoInfo, setIpGeoInfo] = useState<IpGeoInfo | null>(null);
  const [lookingUpIp, setLookingUpIp] = useState(false);
  const [viewingAttachment, setViewingAttachment] = useState<Email['attachments'][0] | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [newNote, setNewNote] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [generatingReport, setGeneratingReport] = useState(false);

  useEffect(() => {
    loadCase();
    loadEmails();
  }, [caseId]);

  useEffect(() => {
    if (selectedEmail) {
      loadNotes(selectedEmail.id);
    } else {
      setNotes([]);
    }
  }, [selectedEmail?.id]);

  // Process HTML body to replace cid: references with embedded images
  const processEmailBody = (html: string | undefined, attachments: Email['attachments']): string => {
    if (!html) return "";
    
    let processedHtml = html;
    
    // Replace cid: references with data URLs
    attachments.forEach((attachment) => {
      if (attachment.content_id && attachment.file_path) {
        const dataUrl = `data:${attachment.mime_type};base64,${attachment.file_path}`;
        // Try various CID reference formats
        processedHtml = processedHtml.replace(
          new RegExp(`cid:${attachment.content_id}`, 'gi'),
          dataUrl
        );
        processedHtml = processedHtml.replace(
          new RegExp(`cid:${attachment.content_id.replace('<', '').replace('>', '')}`, 'gi'),
          dataUrl
        );
      }
    });
    
    return processedHtml;
  };

  const loadCase = async () => {
    try {
      const cases = await invoke<any[]>("get_cases");
      const currentCase = cases.find(c => c.id === Number(caseId));
      if (currentCase) {
        setCaseName(currentCase.name);
      }
    } catch (error) {
      console.error("Failed to load case:", error);
    }
  };

  const loadEmails = async () => {
    try {
      setLoadingEmails(true);
      setError(null);
      console.log("Loading emails for case:", caseId);
      const result = await invoke<Email[]>("get_case_emails", {
        caseId: Number(caseId),
      });
      console.log("Loaded emails:", result);
      setEmails(result);
      
      // Auto-select first email if available
      if (result.length > 0 && !selectedEmail) {
        setSelectedEmail(result[0]);
      }
    } catch (error) {
      console.error("Failed to load emails:", error);
      setError("Failed to load emails: " + String(error));
    } finally {
      setLoadingEmails(false);
    }
  };

  const importEmail = async () => {
    try {
      setError(null);
      console.log("Opening file dialog...");
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: "Email Files",
            extensions: ["eml", "emlx", "msg", "mbox"],
          },
        ],
      });

      if (selected) {
        console.log("Selected file:", selected);
        setLoading(true);
        
        try {
          const result = await invoke("parse_email_file", {
            filePath: selected,
            caseId: Number(caseId),
          });
          console.log("Email parsed successfully:", result);
          await loadEmails();
        } catch (parseError) {
          console.error("Parse error:", parseError);
          setError("Failed to parse email: " + String(parseError));
          alert("Failed to parse email: " + String(parseError));
        } finally {
          setLoading(false);
        }
      } else {
        console.log("No file selected");
      }
    } catch (error) {
      console.error("Failed to import email:", error);
      setLoading(false);
      setError("Failed to import email: " + String(error));
      alert("Failed to import email: " + String(error));
    }
  };

  const toggleFlag = async (emailId: number, currentFlag: boolean) => {
    try {
      await invoke("flag_email", {
        emailId,
        flagged: !currentFlag,
      });
      
      // Update local state
      setEmails(
        emails.map((e) =>
          e.id === emailId ? { ...e, flagged: !currentFlag } : e
        )
      );
      
      if (selectedEmail && selectedEmail.id === emailId) {
        setSelectedEmail({ ...selectedEmail, flagged: !currentFlag });
      }
    } catch (error) {
      console.error("Failed to toggle flag:", error);
    }
  };

  const toggleAttachmentFlag = async (attachmentId: number, flagged: boolean) => {
    try {
      await invoke("flag_attachment", {
        attachmentId,
        flagged,
      });
      
      // Update local state
      if (selectedEmail) {
        const updatedAttachments = selectedEmail.attachments.map((att) =>
          att.id === attachmentId ? { ...att, flagged } : att
        );
        setSelectedEmail({ ...selectedEmail, attachments: updatedAttachments });
        
        // Update in emails list
        setEmails(
          emails.map((e) =>
            e.id === selectedEmail.id
              ? { ...e, attachments: updatedAttachments }
              : e
          )
        );
        
        // Update viewing attachment if it's the one being viewed
        if (viewingAttachment && viewingAttachment.id === attachmentId) {
          setViewingAttachment({ ...viewingAttachment, flagged });
        }
      }
    } catch (error) {
      console.error("Failed to toggle attachment flag:", error);
    }
  };

  const lookupIp = async (ipAddress: string) => {
    try {
      setLookingUpIp(true);
      setIpGeoInfo(null);
      console.log("Looking up IP:", ipAddress);
      const result = await invoke<IpGeoInfo>("lookup_ip_info", {
        ipAddress,
      });
      console.log("IP lookup result:", result);
      setIpGeoInfo(result);
    } catch (error) {
      console.error("Failed to lookup IP:", error);
      alert("Failed to lookup IP: " + String(error));
    } finally {
      setLookingUpIp(false);
    }
  };

  const loadNotes = async (emailId: number) => {
    try {
      console.log("Loading notes for email:", emailId);
      const result = await invoke<Note[]>("get_email_notes", {
        emailId,
      });
      console.log("Loaded notes:", result);
      setNotes(result);
    } catch (error) {
      console.error("Failed to load notes:", error);
    }
  };

  const saveNote = async () => {
    if (!selectedEmail || !newNote.trim()) return;
    
    try {
      setSavingNote(true);
      console.log("Saving note for email:", selectedEmail.id);
      const result = await invoke<Note>("add_note", {
        emailId: selectedEmail.id,
        attachmentId: null,
        content: newNote.trim(),
      });
      console.log("Note saved:", result);
      setNotes([result, ...notes]);
      setNewNote("");
      
      // Auto-flag the email when a note is added
      if (!selectedEmail.flagged) {
        console.log("Auto-flagging email due to note");
        await toggleFlag(selectedEmail.id, false);
      }
    } catch (error) {
      console.error("Failed to save note:", error);
      alert("Failed to save note: " + String(error));
    } finally {
      setSavingNote(false);
    }
  };

  const generateReport = async () => {
    if (!caseId) return;

    try {
      setGeneratingReport(true);
      setError(null);
      
      console.log("Opening folder dialog...");
      const result = await open({
        directory: true,
        title: "Select folder to save report",
      });

      console.log("Selected folder:", result);

      if (!result) {
        console.log("No folder selected, cancelling");
        setGeneratingReport(false);
        return;
      }

      console.log("Generating report for case:", caseId, "to folder:", result);
      const reportPath = await invoke<string>("generate_case_report", {
        caseId: Number(caseId),
        outputPath: result as string,
      });

      console.log("Report generated at:", reportPath);
      
      // Open the report in default browser
      try {
        await invoke("open_file", { path: reportPath });
        console.log("Opened report in browser");
      } catch (openError) {
        console.error("Failed to open report:", openError);
      }
      
      // Show success message with path
      alert(`Report generated successfully!\n\nOpening in browser...\n\nSaved to:\n${reportPath}`);
    } catch (err) {
      console.error("Failed to generate report:", err);
      setError(`Failed to generate report: ${err}`);
      alert(`Failed to generate report: ${err}`);
    } finally {
      setGeneratingReport(false);
    }
  };

  return (
    <div className="h-screen flex flex-col bg-dark-bg overflow-hidden">
      {/* Compact Header */}
      <div className="h-16 flex-shrink-0 border-b border-dark-border flex items-center justify-between px-4 bg-dark-surface">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate("/")}
            className="text-aperture-cyan hover:text-aperture-blue transition-colors text-base font-medium"
          >
            ← Cases
          </button>
          <div className="h-6 w-px bg-dark-border"></div>
          <h1 className="text-base font-semibold text-white">
            {caseName || `Case #${caseId}`}
          </h1>
        </div>
        <div className="flex gap-2">
          <button 
            onClick={importEmail} 
            className="px-4 py-2 text-base rounded-lg bg-aperture-gradient text-white font-medium hover:shadow-aperture transition-all disabled:opacity-50" 
            disabled={loading}
          >
            {loading ? "Importing..." : "+ Import"}
          </button>
          <button 
            onClick={generateReport}
            disabled={generatingReport || emails.length === 0}
            className="px-4 py-2 text-base rounded-lg bg-gradient-to-r from-blue-600 to-purple-600 text-white font-medium hover:shadow-lg hover:shadow-blue-500/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {generatingReport ? (
              <>
                <span className="animate-spin">⚙️</span>
                Generating...
              </>
            ) : (
              <>
                <span>📊</span>
                Generate Report
              </>
            )}
          </button>
        </div>
      </div>

      {/* Error Message */}
      {error && (
        <div className="mx-4 my-2 p-2 bg-red-900/20 border border-red-500 rounded text-xs text-red-400">
          {error}
        </div>
      )}

      {/* Main Content - Two Pane Layout */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Email List Pane */}
        <div className="w-80 flex-shrink-0 border-r border-dark-border flex flex-col bg-dark-surface">
          <div className="px-3 py-2 border-b border-dark-border flex-shrink-0">
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide">
              Emails ({emails.length})
            </h2>
          </div>
          
          <div className="flex-1 overflow-y-auto">
            {loadingEmails ? (
              <div className="flex items-center justify-center h-full">
                <div className="text-aperture-cyan animate-pulse">
                  Loading emails...
                </div>
              </div>
            ) : emails.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full p-8 text-center">
                <div className="text-6xl mb-4">📬</div>
                <h3 className="text-lg font-semibold text-gray-400 mb-2">
                  No Emails Yet
                </h3>
                <p className="text-sm text-gray-500 mb-6">
                  Import .eml or .mbox files to begin analysis
                </p>
                <button 
                  onClick={importEmail} 
                  className="btn-primary"
                  disabled={loading}
                >
                  Import First Email
                </button>
              </div>
            ) : (
              emails.map((email) => (
                <div
                  key={email.id}
                  onClick={() => {
                    setSelectedEmail(email);
                    setIpGeoInfo(null); // Reset IP info when switching emails
                  }}
                  className={`p-3 border-b border-dark-border cursor-pointer transition-all relative ${
                    selectedEmail?.id === email.id
                      ? "bg-gradient-to-r from-aperture-blue/10 to-transparent border-l-2 border-l-aperture-cyan"
                      : "hover:bg-dark-card border-l-2 border-l-transparent hover:border-l-aperture-cyan/30"
                  }`}
                >
                  {selectedEmail?.id === email.id && (
                    <div className="absolute right-2 top-2 w-1.5 h-1.5 bg-aperture-cyan rounded-full animate-pulse"></div>
                  )}
                  <div className="flex items-start justify-between mb-1">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-1">
                        {email.flagged && (
                          <span className="text-lg">🚩</span>
                        )}
                        <h3 className={`text-[15px] font-medium truncate ${
                          selectedEmail?.id === email.id ? "text-white" : "text-gray-300"
                        }`}>
                          {email.subject}
                        </h3>
                      </div>
                      <p className="text-[14px] text-aperture-cyan truncate">
                        {email.from}
                      </p>
                    </div>
                  </div>
                  <p className="text-[14px] text-gray-500">
                    {new Date(email.date).toLocaleString()}
                  </p>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Email Detail Pane */}
        <div className="flex-1 flex bg-dark-bg overflow-hidden">
          {selectedEmail ? (
            <>
              <div className="flex-1 flex flex-col min-w-0">
                {/* Email Header */}
              <div className="p-4 border-b border-dark-border bg-dark-surface flex-shrink-0">
                <div className="flex items-start justify-between mb-3 gap-3">
                  <h2 className="text-lg font-bold text-white flex-1 line-clamp-2">
                    {selectedEmail.subject}
                  </h2>
                  <button
                    onClick={() => toggleFlag(selectedEmail.id, selectedEmail.flagged)}
                    className={`px-3 py-1.5 text-sm rounded-lg transition-all flex-shrink-0 ${
                      selectedEmail.flagged
                        ? "bg-aperture-magenta/20 text-aperture-magenta border border-aperture-magenta"
                        : "bg-dark-card text-gray-400 border border-dark-border hover:border-aperture-magenta"
                    }`}
                  >
                    {selectedEmail.flagged ? "🚩" : "Flag"}
                  </button>
                </div>
                
                <div className="space-y-1.5 text-sm">
                  <div className="flex">
                    <span className="text-gray-500 w-16 font-medium">From:</span>
                    <span className="text-aperture-cyan truncate">{selectedEmail.from}</span>
                  </div>
                  <div className="flex">
                    <span className="text-gray-500 w-16 font-medium">To:</span>
                    <span className="text-white truncate">{selectedEmail.to.join(", ")}</span>
                  </div>
                  <div className="flex">
                    <span className="text-gray-500 w-16 font-medium">Date:</span>
                    <span className="text-white">
                      {new Date(selectedEmail.date).toLocaleString()}
                    </span>
                  </div>
                </div>

                {/* IP Classification */}
                {selectedEmail.originating_ip && (
                  <div className="mt-3 p-3 bg-gradient-to-br from-dark-card to-dark-surface rounded-lg border border-aperture-cyan/30">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <div className="w-1.5 h-1.5 rounded-full bg-aperture-cyan animate-pulse"></div>
                        <span className="text-gray-400 text-sm font-semibold uppercase tracking-wide">
                          IP Analysis
                        </span>
                      </div>
                      <button
                        onClick={() => lookupIp(selectedEmail.originating_ip!.ip_address)}
                        disabled={lookingUpIp}
                        className="px-2 py-1 text-sm bg-aperture-cyan/20 text-aperture-cyan border border-aperture-cyan/50 rounded hover:bg-aperture-cyan/30 transition-all disabled:opacity-50"
                      >
                        {lookingUpIp ? "..." : "🌐 Lookup"}
                      </button>
                    </div>
                    
                    <div className="grid grid-cols-3 gap-2 mb-2">
                      <div>
                        <div className="text-sm text-gray-500 mb-0.5">IP</div>
                        <div className="font-mono text-white text-base">
                          {selectedEmail.originating_ip.ip_address}
                        </div>
                      </div>
                      <div>
                        <div className="text-sm text-gray-500 mb-0.5">Type</div>
                        <span
                          className={`inline-block px-2 py-0.5 rounded text-sm ${
                            selectedEmail.originating_ip.classification === "EndUserOriginating"
                              ? "bg-yellow-500/20 text-yellow-400"
                              : "bg-blue-500/20 text-blue-400"
                          }`}
                        >
                          {selectedEmail.originating_ip.classification === "EndUserOriginating"
                            ? "⚠️ User"
                            : "🖥️ Server"}
                        </span>
                      </div>
                      <div>
                        <div className="text-sm text-gray-500 mb-0.5">Confidence</div>
                        <div className="flex items-center gap-1">
                          <div className="flex-1 h-1.5 bg-dark-surface rounded-full overflow-hidden">
                            <div 
                              className="h-full bg-gradient-to-r from-aperture-cyan to-aperture-blue"
                              style={{ width: `${selectedEmail.originating_ip.confidence * 100}%` }}
                            ></div>
                          </div>
                          <span className="text-white text-sm">
                            {(selectedEmail.originating_ip.confidence * 100).toFixed(0)}%
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Geo Information */}
                    {ipGeoInfo && (
                      <div className="pt-2 border-t border-dark-border">
                        <div className="grid grid-cols-2 gap-2 text-sm">
                          {ipGeoInfo.country && (
                            <div>
                              <span className="text-gray-500">Country:</span>
                              <span className="ml-1 text-white">
                                {ipGeoInfo.country_code}
                              </span>
                            </div>
                          )}
                          {ipGeoInfo.city && (
                            <div>
                              <span className="text-gray-500">City:</span>
                              <span className="ml-1 text-white">{ipGeoInfo.city}</span>
                            </div>
                          )}
                          {ipGeoInfo.isp && (
                            <div className="col-span-2">
                              <span className="text-gray-500">ISP:</span>
                              <span className="ml-1 text-aperture-cyan">{ipGeoInfo.isp}</span>
                            </div>
                          )}
                          {ipGeoInfo.org && (
                            <div className="col-span-2">
                              <span className="text-gray-500">Org:</span>
                              <span className="ml-1 text-white truncate">{ipGeoInfo.org}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Headers (Between IP and Body) */}
              <div className="px-4 py-2 border-t border-dark-border bg-dark-surface/50 flex-shrink-0">
                <button
                  onClick={() => setShowHeaders(!showHeaders)}
                  className="w-full flex items-center justify-between p-2 bg-dark-surface rounded border border-dark-border hover:border-aperture-cyan transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-base font-semibold text-aperture-cyan">
                      Email Headers
                    </span>
                    <span className="text-sm text-gray-500">
                      ({selectedEmail.headers?.length || 0})
                    </span>
                  </div>
                  <span className="text-aperture-cyan text-sm">
                    {showHeaders ? "▼" : "▶"}
                  </span>
                </button>
                {showHeaders && selectedEmail.headers && selectedEmail.headers.length > 0 && (
                  <div className="mt-2 bg-dark-surface p-2 rounded border border-dark-border max-h-48 overflow-y-auto">
                    {selectedEmail.headers.map((header, idx) => (
                      <div key={idx} className="mb-1 text-sm font-mono">
                        <span className="text-aperture-cyan font-semibold">
                          {header.key}:
                        </span>{" "}
                        <span className="text-gray-300">{header.value}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Email Body */}
              <div className="flex-1 overflow-y-auto p-4 min-h-0">
                <div className="bg-dark-surface p-3 rounded-lg border border-dark-border mb-3">
                  {selectedEmail.body_html ? (
                    <iframe
                      srcDoc={processEmailBody(selectedEmail.body_html, selectedEmail.attachments)}
                      className="w-full bg-white rounded"
                      style={{
                        minHeight: '400px',
                        height: 'auto',
                        border: 'none',
                      }}
                      sandbox="allow-same-origin"
                      title="Email content"
                    />
                  ) : (
                    <pre className="whitespace-pre-wrap font-sans text-gray-300 text-base leading-relaxed">
                      {selectedEmail.body_text || "(No text content)"}
                    </pre>
                  )}
                </div>

                {/* Attachments */}
                {selectedEmail.attachments && selectedEmail.attachments.length > 0 && (
                  <div className="mb-3">
                    <h3 className="text-base font-semibold text-aperture-cyan mb-2">
                      Attachments ({selectedEmail.attachments.length})
                    </h3>
                    <div className="space-y-1">
                      {selectedEmail.attachments.map((att) => (
                        <div
                          key={att.id}
                          className="flex items-center justify-between p-2 bg-dark-surface rounded border border-dark-border"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              {att.flagged && (
                                <span className="text-aperture-magenta text-base">🚩</span>
                              )}
                              <div className="font-medium text-white text-sm truncate">
                                {att.filename}
                              </div>
                            </div>
                            <div className="text-sm text-gray-500">
                              {att.mime_type} • {(att.size / 1024).toFixed(1)} KB
                            </div>
                          </div>
                          <button 
                            onClick={() => setViewingAttachment(att)}
                            className="px-2 py-1 text-sm bg-dark-card text-aperture-cyan border border-aperture-cyan/50 rounded hover:bg-aperture-cyan/10"
                          >
                            View
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                </div>
              </div>

              {/* Notes Sidebar */}
            <div className="w-80 flex-shrink-0 border-l border-dark-border bg-dark-surface flex flex-col">
              <div className="px-3 py-2 border-b border-dark-border flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wide">
                    Evidence Notes
                  </h3>
                  <span className="text-sm text-gray-500">({notes.length})</span>
                </div>
                {selectedEmail.flagged && (
                  <span className="text-aperture-magenta text-base">🚩</span>
                )}
              </div>

              {/* Add Note */}
              <div className="p-3 border-b border-dark-border">
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder="Add investigation notes..."
                  className="w-full px-3 py-2 bg-dark-bg border border-dark-border rounded text-white text-base placeholder-gray-500 focus:border-aperture-cyan focus:outline-none focus:ring-1 focus:ring-aperture-cyan/20 resize-none"
                  rows={4}
                />
                <button
                  onClick={saveNote}
                  disabled={!newNote.trim() || savingNote}
                  className="w-full mt-2 px-3 py-1.5 text-sm rounded bg-aperture-gradient text-white font-medium hover:shadow-aperture transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {savingNote ? (
                    <>
                      <span className="animate-spin">⚙️</span>
                      Saving...
                    </>
                  ) : (
                    <>
                      <span>📝</span>
                      Save Note
                    </>
                  )}
                </button>
              </div>

              {/* Notes List */}
              <div className="flex-1 overflow-y-auto p-3 space-y-2">
                {notes.length === 0 ? (
                  <div className="text-center py-8 text-gray-500 text-sm">
                    <div className="text-3xl mb-2">📝</div>
                    <p className="text-base">No notes yet</p>
                    <p className="mt-1 text-sm">Add investigation notes above</p>
                  </div>
                ) : (
                  notes.map((note) => (
                    <div
                      key={note.id}
                      className="p-3 bg-dark-card rounded border border-dark-border hover:border-aperture-cyan/30 transition-colors"
                    >
                      <div className="flex items-start gap-2 mb-2">
                        <span className="text-lg mt-0.5">📝</span>
                        <p className="text-base text-white whitespace-pre-wrap flex-1 leading-relaxed">
                          {note.content}
                        </p>
                      </div>
                      <div className="text-sm text-gray-500 pl-7">
                        {new Date(note.created_at).toLocaleString()}
                      </div>
                    </div>
                  ))
                )}
              </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-gray-500">
              <div className="text-center">
                <div className="text-6xl mb-4">📧</div>
                <p>Select an email to view details</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Attachment Viewer Modal */}
      {viewingAttachment && (
        <AttachmentViewer
          attachment={viewingAttachment}
          onClose={() => setViewingAttachment(null)}
          onFlagToggle={toggleAttachmentFlag}
        />
      )}
    </div>
  );
}

export default CaseView;
