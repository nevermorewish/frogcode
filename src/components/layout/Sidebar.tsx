import React, { useState, useEffect } from 'react';
import {
  FolderOpen,
  Settings,
  BarChart2,
  Terminal,
  Layers,
  FileText,
  Package,
  ChevronLeft,
  ChevronRight,
  HelpCircle,
  User,
  Home,
  ScrollText,
  Radio,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { View } from '@/types/navigation';

const OpenClawIcon: React.FC<{ className?: string; strokeWidth?: number }> = ({ className }) => (
  <svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <defs>
      <linearGradient id="sidebar-oc" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#ff4d4d" />
        <stop offset="100%" stopColor="#991b1b" />
      </linearGradient>
    </defs>
    <path d="M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z" fill="url(#sidebar-oc)" />
    <path d="M20 45 C5 40 0 50 5 60 C10 70 20 65 25 55 C28 48 25 45 20 45Z" fill="url(#sidebar-oc)" />
    <path d="M100 45 C115 40 120 50 115 60 C110 70 100 65 95 55 C92 48 95 45 100 45Z" fill="url(#sidebar-oc)" />
    <path d="M45 15 Q35 5 30 8" stroke="#ff4d4d" strokeWidth="3" strokeLinecap="round" />
    <path d="M75 15 Q85 5 90 8" stroke="#ff4d4d" strokeWidth="3" strokeLinecap="round" />
    <circle cx="45" cy="35" r="6" fill="#050810" />
    <circle cx="75" cy="35" r="6" fill="#050810" />
    <circle cx="46" cy="34" r="2.5" fill="#00e5cc" />
    <circle cx="76" cy="34" r="2.5" fill="#00e5cc" />
  </svg>
);
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Popover } from '@/components/ui/popover';
import { UnifiedEngineStatus } from '@/components/UnifiedEngineStatus';
import { UpdateBadge } from '@/components/common/UpdateBadge';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { useAuth } from '@/contexts/AuthContext';
import { LoginDialog } from '@/components/LoginDialog';

interface SidebarProps {
  currentView: View;
  onNavigate: (view: View) => void;
  className?: string;
  onAboutClick?: () => void;
  onUpdateClick?: () => void;
}

interface NavItem {
  view: View;
  icon: React.ElementType;
  label: string;
  shortcut?: string;
}

const STORAGE_KEY = 'sidebar_expanded';

export const Sidebar: React.FC<SidebarProps> = ({
  currentView,
  onNavigate,
  className,
  onAboutClick,
  onUpdateClick
}) => {
  const { t } = useTranslation();
  const { user, isAuthenticated, logout, tokens, selectedTokenId, selectToken } = useAuth();
  const [loginOpen, setLoginOpen] = useState(false);
  const [switchingToken, setSwitchingToken] = useState(false);

  // 展开/收起状态，从 localStorage 读取
  const [isExpanded, setIsExpanded] = useState(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored !== null ? stored === 'true' : true; // 默认展开
  });

  // 持久化状态到 localStorage
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(isExpanded));
  }, [isExpanded]);

  // 会话页面时自动收起
  useEffect(() => {
    if (currentView === 'claude-code-session' || currentView === 'claude-tab-manager') {
      setIsExpanded(false);
    }
  }, [currentView]);

  const mainNavItems: NavItem[] = [
    { view: 'home', icon: Home, label: t('sidebar.home') },
    { view: 'projects', icon: FolderOpen, label: t('common.ccProjectsTitle') },
    { view: 'claude-tab-manager', icon: Terminal, label: t('sidebar.sessionManagement') },
    { view: 'prompt-editor', icon: FileText, label: t('sidebar.prompts', '提示词') },
    { view: 'usage-dashboard', icon: BarChart2, label: t('sidebar.usageStats') },
    { view: 'mcp', icon: Layers, label: t('sidebar.mcpTools') },
    { view: 'openclaw-sessions', icon: OpenClawIcon, label: 'OpenClaw' },
    { view: 'im-channels', icon: Radio, label: t('sidebar.imChannels', 'IM 通道') },
    { view: 'logs', icon: ScrollText, label: t('sidebar.logs', '日志') },
    { view: 'claude-extensions', icon: Package, label: t('sidebar.extensions') },
  ];

  const NavButton = ({ item }: { item: NavItem }) => {
    const isActive = currentView === item.view;

    const buttonContent = (
      <Button
        variant={isActive ? "secondary" : "ghost"}
        className={cn(
          "rounded-xl mb-2 transition-all duration-200",
          isExpanded ? "w-full justify-start px-3 h-10" : "w-10 h-10",
          isActive
            ? "bg-primary/15 text-primary hover:bg-primary/20 shadow-sm"
            : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
        )}
        onClick={() => onNavigate(item.view)}
      >
        <item.icon className="w-5 h-5" strokeWidth={isActive ? 2.5 : 2} />
        {isExpanded && (
          <span className="ml-3 text-sm font-medium">{item.label}</span>
        )}
        {!isExpanded && <span className="sr-only">{item.label}</span>}
      </Button>
    );

    // 收起模式显示 Tooltip
    if (!isExpanded) {
      return (
        <TooltipProvider delayDuration={0}>
          <Tooltip>
            <TooltipTrigger asChild>{buttonContent}</TooltipTrigger>
            <TooltipContent side="right" className="flex items-center gap-2 px-3 py-1.5">
              <span className="font-medium">{item.label}</span>
              {item.shortcut && (
                <span className="text-xs text-muted-foreground bg-muted px-1 rounded border">
                  {item.shortcut}
                </span>
              )}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );
    }

    return buttonContent;
  };

  return (
    <div
      className={cn(
        "flex flex-col py-4 h-full transition-all duration-300 ease-[cubic-bezier(0.2,0,0,1)]",
        "bg-[var(--glass-bg)] backdrop-blur-[var(--glass-blur)] border-r border-[var(--glass-border)]",
        isExpanded ? "w-[12.5rem]" : "w-16",
        isExpanded ? "px-3" : "items-center",
        className
      )}
    >
      {/* Logo 区域 (Removed) */}
      
      {/* 主导航区域 - overflow-y-auto + min-h-0 确保窗口过小时底部按钮仍可见 */}
      <div className={cn("flex-1 flex flex-col w-full min-h-0 overflow-y-auto", isExpanded ? "space-y-1" : "items-center space-y-2")}>
        {mainNavItems.map((item) => (
          <NavButton key={item.view} item={item} />
        ))}
      </div>

      {/* 底部状态区域 */}
      <div className={cn(
        "flex flex-col w-full mt-auto pt-4 border-t border-[var(--glass-border)]",
        isExpanded ? "space-y-3" : "items-center"
      )}>
        {/* 多引擎状态指示器 */}
        <div className={cn(isExpanded ? "w-full" : "flex justify-center w-full")}>
          <UnifiedEngineStatus
            compact={!isExpanded}
          />
        </div>

        {/* 更新徽章（展开模式） */}
        {isExpanded && (
          <div className="px-2">
            <UpdateBadge onClick={onUpdateClick} />
          </div>
        )}

        {/* 操作按钮行 */}
        <div className={cn(
          "flex items-center gap-1",
          isExpanded ? "justify-around px-2" : "flex-col"
        )}>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div>
                  <ThemeToggle size="sm" className="w-8 h-8" />
                </div>
              </TooltipTrigger>
              {!isExpanded && (
                <TooltipContent side="right">
                  <p>{t('sidebar.themeToggle')}</p>
                </TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>

          {onAboutClick && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={onAboutClick}
                    className="w-8 h-8 text-muted-foreground hover:text-foreground"
                    aria-label={t('sidebar.about')}
                  >
                    <HelpCircle className="w-4 h-4" />
                  </Button>
                </TooltipTrigger>
                {!isExpanded && (
                  <TooltipContent side="right">
                    <p>{t('sidebar.about')}</p>
                  </TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>
          )}
        </div>

        {/* 用户信息 / 登录按钮 + 展开/收起 */}
        <div className={cn(
          "flex flex-col gap-1 pt-2 border-t border-[var(--glass-border)]",
          isExpanded ? "px-2" : "items-center"
        )}>
          {isAuthenticated ? (
            <Popover
              align="start"
              side="top"
              className="w-56 p-1"
              trigger={
                isExpanded ? (
                  <Button
                    variant="ghost"
                    className="w-full justify-start gap-2 px-3 h-10 rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted/50"
                  >
                    <User className="w-5 h-5" strokeWidth={2} />
                    <span className="ml-1 text-sm font-medium truncate">
                      {user?.display_name || user?.username}
                    </span>
                  </Button>
                ) : (
                  <TooltipProvider delayDuration={0}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          className="w-10 h-10 rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted/50"
                        >
                          <User className="w-5 h-5" strokeWidth={2} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="right">
                        <p>{user?.display_name || user?.username}</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )
              }
              content={
                <div className="flex flex-col gap-0.5">
                  <div className="px-3 py-2 text-sm text-muted-foreground truncate">
                    {user?.display_name || user?.username}
                  </div>
                  {tokens.length > 1 && (
                    <div className="px-2 py-1">
                      <div className="text-xs text-muted-foreground mb-1 px-1">{t('apiToken', 'API Token')}</div>
                      <select
                        className="w-full text-xs px-2 py-1.5 rounded-md border border-border bg-background text-foreground cursor-pointer"
                        value={selectedTokenId ?? ''}
                        disabled={switchingToken}
                        onChange={async (e) => {
                          const id = Number(e.target.value);
                          if (id) {
                            setSwitchingToken(true);
                            try { await selectToken(id); } finally { setSwitchingToken(false); }
                          }
                        }}
                      >
                        {tokens.map((token) => (
                          <option key={token.id} value={token.id}>
                            {token.name}{token.group ? ` [${token.group}]` : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  <Button
                    variant="ghost"
                    className="w-full justify-start gap-2 h-9 text-destructive hover:text-destructive"
                    onClick={logout}
                  >
                    {t('sidebar.logout', 'Sign Out')}
                  </Button>
                </div>
              }
            />
          ) : isExpanded ? (
            <Button
              variant="ghost"
              className="w-full justify-start gap-2 px-3 h-10 rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted/50"
              onClick={() => setLoginOpen(true)}
            >
              <User className="w-5 h-5" strokeWidth={2} />
              <span className="ml-1 text-sm font-medium truncate">
                {t('sidebar.login', 'Sign In')}
              </span>
            </Button>
          ) : (
            <TooltipProvider delayDuration={0}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    className="w-10 h-10 rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted/50"
                    onClick={() => setLoginOpen(true)}
                  >
                    <User className="w-5 h-5" strokeWidth={2} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  <p>{t('sidebar.login', 'Sign In')}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          {/* Settings button - standalone, below login */}
          {isExpanded ? (
            <Button
              variant="ghost"
              className="w-full justify-start gap-2 px-3 h-10 rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted/50"
              onClick={() => onNavigate('settings')}
            >
              <Settings className="w-5 h-5" strokeWidth={2} />
              <span className="ml-1 text-sm font-medium truncate">
                {t('navigation.settings')}
              </span>
            </Button>
          ) : (
            <TooltipProvider delayDuration={0}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    className="w-10 h-10 rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted/50"
                    onClick={() => onNavigate('settings')}
                  >
                    <Settings className="w-5 h-5" strokeWidth={2} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  <p>{t('navigation.settings')}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          <LoginDialog open={loginOpen} onOpenChange={setLoginOpen} />

          <div className={cn("flex", isExpanded ? "justify-end" : "justify-center")}>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setIsExpanded(!isExpanded)}
                    className="w-8 h-8 text-muted-foreground hover:text-foreground"
                    aria-label={isExpanded ? t('sidebar.collapseSidebar') : t('sidebar.expandSidebar')}
                  >
                    {isExpanded ? (
                      <ChevronLeft className="w-4 h-4" />
                    ) : (
                      <ChevronRight className="w-4 h-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  <p>{isExpanded ? t('sidebar.collapseSidebar') : t('sidebar.expandSidebar')}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>

      </div>
    </div>
  );
};
