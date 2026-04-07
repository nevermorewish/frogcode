import React, { useState } from 'react';
import { FileText, FileCode, Sparkles } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { MarkdownEditor } from '@/components/MarkdownEditor';
import { CodexMarkdownEditor } from '@/components/CodexMarkdownEditor';
import { GeminiMarkdownEditor } from '@/components/GeminiMarkdownEditor';

export const PromptEditorTabs: React.FC = () => {
  const [tab, setTab] = useState('claude');

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 pt-3 pb-0">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="h-9 gap-1">
            <TabsTrigger value="claude" className="gap-1.5 text-[13px]">
              <FileText className="h-3.5 w-3.5" />
              Claude
            </TabsTrigger>
            <TabsTrigger value="codex" className="gap-1.5 text-[13px]">
              <FileCode className="h-3.5 w-3.5" />
              Codex
            </TabsTrigger>
            <TabsTrigger value="gemini" className="gap-1.5 text-[13px]">
              <Sparkles className="h-3.5 w-3.5" />
              Gemini
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className="flex-1 overflow-hidden">
        {tab === 'claude' && <MarkdownEditor />}
        {tab === 'codex' && <CodexMarkdownEditor />}
        {tab === 'gemini' && <GeminiMarkdownEditor />}
      </div>
    </div>
  );
};
