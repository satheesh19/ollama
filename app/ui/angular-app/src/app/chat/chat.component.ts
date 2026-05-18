import { Component, OnInit, signal, ElementRef, ViewChild, computed, effect, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { ApiService } from '../services/api.service';
import { DbService } from '../services/db.service';
import { Chat, Message, Model, ChatInfo } from '../gotypes.gen';

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './chat.component.html'
})
export class ChatComponent implements OnInit {
  @ViewChild('fileInput') fileInput!: ElementRef<HTMLInputElement>;
  @ViewChild('scrollContainer') scrollContainer!: ElementRef<HTMLElement>;

  chatId = signal<string>('new');
  chat = signal<Chat | null>(null);
  messages = signal<Message[]>([]);
  inputText = signal<string>('');
  isStreaming = signal<boolean>(false);
  isLoading = signal<boolean>(false);

  // New features
  models = signal<Model[]>([]);
  selectedModel = signal<string>('');
  isModelDropdownOpen = signal<boolean>(false);
  recentChats = signal<ChatInfo[]>([]);
  attachments = signal<{ filename: string, type: 'image' | 'document', data: string, url: string }[]>([]);

  // Capability monitoring signals
  currentModelCapabilities = signal<string[]>([]);
  hasVision = computed(() => this.currentModelCapabilities().includes('vision'));
  hasThinking = computed(() => this.currentModelCapabilities().includes('thinking'));
  isThinkingEnabled = signal<boolean>(false);
  contextLength = signal<number>(4096);
  isContextDropdownOpen = signal<boolean>(false);
  modelMaxContext = signal<number>(8192);
  activeAbortController = signal<AbortController | null>(null);
  isSidebarOpen = signal<boolean>(true);
  isOllamaOnline = signal<boolean>(true);
  isMobileOptionsOpen = signal<boolean>(false);

  // Dynamic host system VRAM profile tracking
  systemVRAM = signal<number>(8.0); // Default fallback VRAM size (8GB)
  modelSizeGB = signal<number>(4.0); // Size of the currently active model weight in GB

  modelContextOptions = computed(() => this.generateContextOptions(this.modelMaxContext()));

  constructor(
    public route: ActivatedRoute,
    public router: Router,
    private api: ApiService,
    private db: DbService,
    private el: ElementRef
  ) {
    // Automatically load capabilities whenever the model is switched
    effect(() => {
      const modelName = this.selectedModel();
      if (modelName) {
        this.loadModelCapabilities(modelName);
        try {
          localStorage.setItem('ollama_selected_model', modelName);
        } catch (e) { }
      }
    });
  }

  ngOnInit() {
    this.isSidebarOpen.set(window.innerWidth >= 768);

    this.route.paramMap.subscribe(params => {
      const id = params.get('chatId') || 'new';
      this.chatId.set(id);

      if (this.isMobile()) {
        this.isSidebarOpen.set(false);
        this.isMobileOptionsOpen.set(false);
      }

      if (id !== 'new') {
        this.loadChat(id);
      } else {
        this.chat.set(null);
        this.messages.set([]);
      }
    });

    // Proactively query local host system hardware VRAM specifications
    this.api.getSystemGPUInfo().subscribe({
      next: (info) => {
        if (info && info.total_memory_gb) {
          console.log(`Host hardware profiles resolved: ${info.gpu_name} with ${info.total_memory_gb} GB Total VRAM`);
          this.systemVRAM.set(info.total_memory_gb);
          // Reactively regenerate options
          this.modelMaxContext.update(v => v);
        }
      },
      error: (err) => {
        console.warn('Running in standalone proxy-less environment; falling back to standard 8GB GPU layout.', err);
      }
    });

    // Load thinking and context length configurations
    try {
      const saved = localStorage.getItem('ollama_ui_settings');
      if (saved) {
        const s = JSON.parse(saved);
        this.isThinkingEnabled.set(s.thinking === true);
        this.contextLength.set(Number(s.contextLength) || 4096);
      }
    } catch (e) { }

    this.loadModels();
    this.loadRecentChats();

    // Monitor daemon connectivity status
    this.checkOllamaConnection();
    setInterval(() => {
      this.checkOllamaConnection();
    }, 10000);
  }

  isMobile(): boolean {
    return typeof window !== 'undefined' && window.innerWidth < 768;
  }

  isCollapsedHeader(): boolean {
    return typeof window !== 'undefined' && window.innerWidth < 1024;
  }

  toggleSidebar() {
    this.isSidebarOpen.update(o => !o);
  }

  toggleMobileOptions() {
    this.isMobileOptionsOpen.update(o => !o);
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (!target) return;

    // Check if the click was inside the model picker container
    if (this.isModelDropdownOpen() && !target.closest('.model-picker-container')) {
      this.isModelDropdownOpen.set(false);
    }

    // Check if the click was inside the context dropdown container (both desktop and mobile container)
    if (this.isContextDropdownOpen() && !target.closest('.context-picker-container') && !target.closest('.context-picker-container-mobile')) {
      this.isContextDropdownOpen.set(false);
    }

    // Check if the click was inside the mobile/desktop options cog panel container
    if (this.isMobileOptionsOpen() && !target.closest('.model-options-container')) {
      this.isMobileOptionsOpen.set(false);
    }
  }

  checkOllamaConnection() {
    this.api.getModels().subscribe({
      next: () => this.isOllamaOnline.set(true),
      error: () => this.isOllamaOnline.set(false)
    });
  }

  handleEnterKey(event: Event) {
    event.preventDefault();
    if (!this.isOllamaOnline() || this.isStreaming()) {
      return;
    }
    this.handleSubmit();
  }

  scrollToBottom() {
    setTimeout(() => {
      if (this.scrollContainer) {
        const el = this.scrollContainer.nativeElement;
        el.scrollTop = el.scrollHeight;
      }
    }, 50);
  }

  loadModels() {
    this.api.getModels().subscribe({
      next: (res) => {
        const mods = res.models || [];
        this.models.set(mods);
        // Default to llama3 or first model available
        if (mods.length > 0) {
          const llama = mods.find(m => m.model.includes('llama3'))?.model;
          this.selectedModel.set(llama || mods[0].model);
        } else {
          this.selectedModel.set('llama3'); // Fallback
        }
      },
      error: () => {
        // Mock fallback if api is down
        this.models.set([{ model: 'llama3' } as Model]);
        this.selectedModel.set('llama3');
      }
    });
  }

  loadRecentChats() {
    // Since we decoupled the Go backend, we use LocalStorage for chat history
    try {
      const savedChats = localStorage.getItem('ollama_chats');
      if (savedChats) {
        this.recentChats.set(JSON.parse(savedChats));
      } else {
        this.recentChats.set([]);
      }
    } catch (e) {
      console.error('Failed to load chats from local storage', e);
      this.recentChats.set([]);
    }
  }

  async saveChatHistory() {
    try {
      // Find or update the current chat in the recent list
      const chats = [...this.recentChats()] as any[];
      const existingIdx = chats.findIndex(c => c.id === this.chatId());

      const title = this.messages().find(m => m.role === 'user')?.content?.substring(0, 30) || 'New Chat';

      if (existingIdx >= 0) {
        chats[existingIdx].title = title + '...';
        chats[existingIdx].model = this.selectedModel();
        chats[existingIdx].contextLength = this.contextLength(); // Save selected context length!
      } else {
        chats.unshift({ 
          id: this.chatId(), 
          title: title + '...', 
          model: this.selectedModel(),
          contextLength: this.contextLength() // Save selected context length!
        });
      }

      this.recentChats.set(chats);
      localStorage.setItem('ollama_chats', JSON.stringify(chats));

      // Save full-resolution messages (with original screenshots/attachments) directly in IndexedDB!
      // This bypasses the 5MB browser LocalStorage cap completely, supporting hundreds of megabytes of chats.
      await this.db.saveChat(this.chatId(), this.messages());
    } catch (e) {
      console.error('Failed to save chat to IndexedDB:', e);
    }
  }

  async loadChat(id: string) {
    this.isLoading.set(true);
    try {
      const savedMessages = await this.db.getChat(id);
      this.messages.set(savedMessages || []);
      this.scrollToBottom();

      // Auto-switch to model used for this chat
      const chatInfo = this.recentChats().find(c => c.id === id) as any;
      if (chatInfo) {
        if (chatInfo.model) {
          this.selectedModel.set(chatInfo.model);
        }
        if (chatInfo.contextLength) {
          this.contextLength.set(chatInfo.contextLength);
        }
      }
    } catch (e) {
      this.messages.set([]);
    } finally {
      this.isLoading.set(false);
    }
  }

  selectModel(model: string) {
    this.selectedModel.set(model);
    this.isModelDropdownOpen.set(false);
  }

  loadModelCapabilities(modelName: string) {
    if (!modelName) return;
    this.api.getModelInfo(modelName).subscribe({
      next: (res) => {
        let caps = res.capabilities || [];

        // Robust fallback capability detection in case running on an older Ollama daemon
        if (caps.length === 0) {
          const lowerName = modelName.toLowerCase();
          const details = res.details;
          if (details && details.families && (details.families.includes('mllm') || details.families.includes('vision'))) {
            caps.push('vision');
          } else if (lowerName.includes('llava') || lowerName.includes('vision') || lowerName.includes('minicpm-v') || lowerName.includes('qwen2.5-vl') || lowerName.includes('qwen-vl')) {
            caps.push('vision');
          }

          if (lowerName.includes('deepseek-r1') || lowerName.includes('reasoning') || lowerName.includes('think') || lowerName.includes('qwen-r1') || lowerName.includes('phi-4')) {
            caps.push('thinking');
          }
        }

        //console.log(`Loaded capabilities for ${modelName}:`, caps);
        this.currentModelCapabilities.set(caps);

        // Compute active model weight size in GB for hardware clamping
        let sizeBytes = res.size;
        if (!sizeBytes) {
          const matchedModel = this.models().find(m => m.model === modelName);
          if (matchedModel && (matchedModel as any).size) {
            sizeBytes = (matchedModel as any).size;
          }
        }
        if (sizeBytes) {
          this.modelSizeGB.set(Number(sizeBytes) / (1024 * 1024 * 1024));
        } else {
          this.modelSizeGB.set(4.0); // 4GB standard weight fallback
        }

        // 1. Dynamic context window ceiling resolution from model info
        let maxCtx = 8192; // default fallback
        if (res.model_info) {
          for (const key of Object.keys(res.model_info)) {
            if (key.endsWith('.context_length')) {
              maxCtx = Number(res.model_info[key]) || maxCtx;
              break;
            }
          }
        } else {
          // High-fidelity fallback context caps based on model families
          const lowerName = modelName.toLowerCase();
          if (lowerName.includes('deepseek-r1') || lowerName.includes('llama3.1') || lowerName.includes('llama3.2') || lowerName.includes('llama3.3') || lowerName.includes('qwen2.5') || lowerName.includes('phi4')) {
            maxCtx = 131072; // 128k context support!
          } else if (lowerName.includes('llama3') || lowerName.includes('gemma2')) {
            maxCtx = 8192;
          } else if (lowerName.includes('mistral') || lowerName.includes('mixtral')) {
            maxCtx = 32768;
          } else if (lowerName.includes('llama2') || lowerName.includes('codellama')) {
            maxCtx = 4096;
          }
        }

        //console.log(`Resolved maximum context ceiling for ${modelName}: ${maxCtx}`);
        this.modelMaxContext.set(maxCtx);

        // 1. Resolve max context ceiling
        this.modelMaxContext.set(maxCtx);

        // 2. Calculate safe hardware limit
        const totalVram = this.systemVRAM();
        const modelWeight = this.modelSizeGB();
        const freeVram = totalVram - modelWeight;
        let hardwareLimit = maxCtx;
        if (freeVram <= 1.5) {
          hardwareLimit = 8192;
        } else if (freeVram <= 4.0) {
          hardwareLimit = 16384;
        } else if (freeVram <= 8.0) {
          hardwareLimit = 32768;
        }
        const resolvedMax = Math.min(maxCtx, hardwareLimit);

        // 3. Resolve context length to default:
        // Check if current chat info has a saved model/context selection
        const chatInfo = this.recentChats().find(c => c.id === this.chatId()) as any;
        if (chatInfo && chatInfo.contextLength) {
          // Use chat's previous custom context length selection, clamped to safe maximum
          this.contextLength.set(Math.min(chatInfo.contextLength, resolvedMax));
        } else {
          // Check if user set a global preference in local storage
          try {
            const saved = localStorage.getItem('ollama_ui_settings');
            const s = saved ? JSON.parse(saved) : null;
            if (s && s.contextLength) {
              this.contextLength.set(Math.min(Number(s.contextLength), resolvedMax));
            } else {
              // Default to the full context selector maximum (resolvedMax) instead of minimum fallback!
              this.contextLength.set(resolvedMax);
            }
          } catch (e) {
            this.contextLength.set(resolvedMax);
          }
        }
      },
      error: (err) => {
        console.warn(`Failed to fetch model details for ${modelName}, falling back to default ceilings`, err);
        this.currentModelCapabilities.set([]);
        this.modelMaxContext.set(8192); // default fallback
      }
    });
  }

  toggleThinking() {
    this.isThinkingEnabled.update(t => !t);
    try {
      const saved = localStorage.getItem('ollama_ui_settings');
      let s = saved ? JSON.parse(saved) : {};
      s.thinking = this.isThinkingEnabled();
      localStorage.setItem('ollama_ui_settings', JSON.stringify(s));
      console.log(`Dynamic settings updated: thinking = ${s.thinking}`);
    } catch (e) {
      console.error('Failed to save thinking toggle to local storage', e);
    }
  }

  generateContextOptions(maxCtx: number): number[] {
    const min = 4096;
    const step = 4096;
    if (maxCtx <= min) return [min];

    // Dynamic Hardware VRAM Protection clamping calculations
    const totalVram = this.systemVRAM();
    const modelWeight = this.modelSizeGB();
    const freeVram = totalVram - modelWeight;

    let hardwareLimit = maxCtx;
    if (freeVram <= 1.5) {
      hardwareLimit = 8192; // Very tight VRAM context clamping
      //console.warn(`Low host GPU headroom detected (${freeVram.toFixed(1)} GB free). Hardware clamping context dropdown choices to 8k.`);
    } else if (freeVram <= 4.0) {
      hardwareLimit = 16384; // Medium VRAM ceiling clamping
      //console.warn(`Moderate host GPU headroom detected (${freeVram.toFixed(1)} GB free). Hardware clamping context dropdown choices to 16k.`);
    } else if (freeVram <= 8.0) {
      hardwareLimit = 32768; // Safe standard clamp
      //console.log(`Standard host GPU headroom detected (${freeVram.toFixed(1)} GB free). Hardware clamping context dropdown choices to 32k.`);
    }

    const resolvedMax = Math.min(maxCtx, hardwareLimit);

    let options: number[] = [];
    if (resolvedMax <= 32768) {
      // Standard increments of 4k
      for (let val = min; val <= resolvedMax; val += step) {
        options.push(val);
      }
    } else {
      // Stepped/logarithmic scale for extremely high context sizes (like 128k)
      options = [4096, 8192, 16384, 32768, 65536, 98304, 131072];
      options = options.filter(val => val <= resolvedMax);
    }

    // Ensure the exact resolved limit is included at the end
    if (!options.includes(resolvedMax)) {
      options.push(resolvedMax);
    }
    // Return sorted options
    return options.sort((a, b) => a - b);
  }

  selectContext(size: number) {
    this.contextLength.set(size);
    this.isContextDropdownOpen.set(false);
    try {
      const saved = localStorage.getItem('ollama_ui_settings');
      let s = saved ? JSON.parse(saved) : {};
      s.contextLength = size;
      localStorage.setItem('ollama_ui_settings', JSON.stringify(s));
      //console.log(`Dynamic context settings updated: contextLength = ${size}`);
    } catch (e) {
      console.error('Failed to save context length to local storage', e);
    }
  }

  getContextWarning(opt: number): string | null {
    if (opt >= 65536) {
      return 'Extreme RAM/OOM Risk';
    }
    if (opt >= 32768) {
      return 'High VRAM';
    }
    return null;
  }

  estimateTokens(text: string): number {
    if (!text) return 0;
    // Standard English token count approximation: 1 token ~ 4 characters
    return Math.ceil(text.length / 4);
  }

  getChatHistoryTokens(): number {
    let count = 0;
    for (const msg of this.messages()) {
      if (msg.content) {
        count += this.estimateTokens(msg.content);
      }
    }
    return count;
  }

  getContextProgress(): number {
    const total = this.getChatHistoryTokens();
    const limit = this.contextLength();
    if (!limit) return 0;
    const percent = Math.round((total / limit) * 100);
    return Math.min(percent, 100);
  }

  triggerFileInput() {
    this.fileInput.nativeElement.click();
  }

  async onFileSelected(event: any) {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    for (let file of files) {
      const isImage = file.type.startsWith('image/');

      if (isImage) {
        if (!this.hasVision()) {
          alert(`Image attachments require a vision-capable model. Switch to a model like LLaVA or Qwen-VL to attach images.`);
          continue;
        }

        const reader = new FileReader();
        reader.onload = (e: any) => {
          const dataUrl = e.target.result;
          const base64Data = dataUrl.split(',')[1];
          this.attachments.update(a => [...a, {
            filename: file.name,
            type: 'image',
            data: base64Data,
            url: dataUrl
          }]);
        };
        reader.readAsDataURL(file);
      } else {
        // Read text/documents as text for client-side RAG context
        const reader = new FileReader();
        reader.onload = (e: any) => {
          const textContent = e.target.result;
          this.attachments.update(a => [...a, {
            filename: file.name,
            type: 'document',
            data: textContent,
            url: 'document'
          }]);
        };
        reader.readAsText(file);
      }
    }
    // reset input
    this.fileInput.nativeElement.value = '';
  }

  removeAttachment(index: number) {
    this.attachments.update(a => a.filter((_, i) => i !== index));
  }

  stopStreaming() {
    const controller = this.activeAbortController();
    if (controller) {
      controller.abort();
      this.activeAbortController.set(null);
      this.isStreaming.set(false);
      console.log('User cancelled/stopped the streaming query request.');
    }
  }

  formatMarkdown(text: string): string {
    // Very basic markdown parsing for code blocks and bold text. 
    // In production, you would use marked.js or highlight.js
    let formatted = text
      .replace(/```([\s\S]*?)```/g, '<pre class="bg-black text-gray-200 p-4 rounded-lg my-2 overflow-x-auto"><code>$1</code></pre>')
      .replace(/`(.*?)`/g, '<code class="bg-black/10 dark:bg-white/10 px-1.5 py-0.5 rounded text-sm">$1</code>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

    return formatted;
  }

  formatContext(tokens: number): string {
    if (tokens >= 1048576) {
      return (tokens / 1048576).toFixed(0) + 'M';
    }
    if (tokens >= 1024) {
      return (tokens / 1024).toFixed(0) + 'k';
    }
    return tokens.toString();
  }

  async handleSubmit() {
    const text = this.inputText().trim();
    if (!text && this.attachments().length === 0) return;

    // Convert attachments to base64 strings only (Ollama raw API expects array of base64 strings)
    const imagesPayload = this.attachments()
      .filter(a => a.type === 'image')
      .map(a => a.data);

    const docsPayload = this.attachments().filter(a => a.type === 'document');

    const newUserMsg = new Message({
      role: 'user',
      content: text,
      created_at: new Date()
    }) as any;

    if (this.attachments().length > 0) {
      const imagePreviews = this.attachments().filter(a => a.type === 'image').map(a => a.url);
      if (imagePreviews.length > 0) {
        newUserMsg.images = imagePreviews;
      }

      const docNames = this.attachments().filter(a => a.type === 'document').map(a => a.filename);
      if (docNames.length > 0) {
        newUserMsg.documents = docNames;
      }
    }

    // In a real app we'd map our Message[] to the format expected by the API.
    // For this prototype, we'll keep our local messages state for the UI,
    // and build the API payload on the fly.
    this.messages.update(m => [...m, newUserMsg]);
    this.inputText.set('');
    this.attachments.set([]);
    this.isStreaming.set(true);

    const controller = new AbortController();
    this.activeAbortController.set(controller);

    this.scrollToBottom();

    const assistantMsg = new Message({
      role: 'assistant',
      content: '',
      created_at: new Date()
    });

    this.messages.update(m => [...m, assistantMsg]);

    try {
      // Build the full conversation history for the stateless API
      // We must exclude the newly added empty assistant message AND any previous empty messages
      // that might poison the LLM's context window and cause an instant End-Of-Stream.
      const conversationPayload = this.messages()
        .filter(m => m !== assistantMsg) // Safely exclude the placeholder
        .filter(m => m.content && m.content.trim().length > 0) // Exclude empty messages
        .map((m, index, arr) => {
          let content = m.content || '';

          // Inject document text context into the user's latest query
          if (index === arr.length - 1) {
            let promptText = content;
            if (docsPayload.length > 0) {
              let contextWrapper = '';
              for (const doc of docsPayload) {
                contextWrapper += `\n\n---\n[Attached Document: ${doc.filename}]\n\`\`\`\n${doc.data}\n\`\`\`\n---`;
              }
              promptText = (promptText + contextWrapper).trim();
            }
            content = promptText;
          }

          // Attach images only to the very last user message
          if (index === arr.length - 1 && imagesPayload.length > 0) {
            return { role: m.role || 'user', content: content, images: imagesPayload };
          }
          return { role: m.role || 'user', content: content };
        });

      // Load inference settings from localStorage
      let inferenceOptions: any = undefined;
      let keepAliveStr: string | undefined = undefined;
      let thinking: boolean | undefined = this.isThinkingEnabled();
      let formatStr: any = undefined;
      let truncateHist: boolean | undefined = undefined;
      try {
        const savedSettings = localStorage.getItem('ollama_ui_settings');
        if (savedSettings) {
          const s = JSON.parse(savedSettings);
          let baseTemp = s.temperature !== undefined ? Number(s.temperature) : 0.7;

          // Dynamic Temperature Scaling (Attention Coherency Adjuster)
          // As context window usage increases beyond 50%, reduce temperature linearly by up to 30% of its base value.
          const progress = this.getContextProgress();
          if (progress > 50) {
            const reductionFactor = 1.0 - ((progress - 50) / 50) * 0.3; // Scale up to 30% reduction at 100% capacity
            const originalTemp = baseTemp;
            baseTemp = baseTemp * reductionFactor;
            //console.log(`[Coherency Adjuster] Context capacity filled at ${progress}%. Temperature dynamically scaled from ${originalTemp} to ${baseTemp.toFixed(3)}.`);
          }

          inferenceOptions = {
            num_ctx: Number(this.contextLength()) || 4096,
            temperature: Number(baseTemp.toFixed(3)),
            top_p: s.topP !== undefined ? Number(s.topP) : 0.9,
            repeat_penalty: s.repeatPenalty !== undefined ? Number(s.repeatPenalty) : 1.1
          };

          if (s.ropeFrequencyBase !== undefined && Number(s.ropeFrequencyBase) > 0) {
            inferenceOptions.rope_frequency_base = Number(s.ropeFrequencyBase);
          }
          if (s.ropeScale !== undefined && Number(s.ropeScale) > 0) {
            inferenceOptions.rope_scale = Number(s.ropeScale);
          }

          if (s.maxTokens !== undefined && Number(s.maxTokens) !== -1) {
            inferenceOptions.num_predict = Number(s.maxTokens);
          }
          if (s.seed !== undefined && Number(s.seed) !== 0) {
            inferenceOptions.seed = Number(s.seed);
          }
          if (s.stopSequences && s.stopSequences.trim()) {
            inferenceOptions.stop = s.stopSequences.split(',').map((str: string) => str.trim());
          }

          if (s.systemPrompt && s.systemPrompt.trim()) {
            // Inject system prompt at the very beginning of the payload
            conversationPayload.unshift({ role: 'system', content: s.systemPrompt.trim() });
          }

          if (s.keepAlive !== undefined) {
            const keepAliveVal = Number(s.keepAlive);
            keepAliveStr = keepAliveVal === -1 ? '-1m' : `${keepAliveVal}m`;
          }

          // Only enable the "think" API parameter if the selected model explicitly supports reasoning capabilities
          thinking = this.hasThinking() ? this.isThinkingEnabled() : undefined;

          if (s.jsonMode) {
            if (s.jsonSchema && s.jsonSchema.trim()) {
              try {
                formatStr = JSON.parse(s.jsonSchema.trim());
              } catch (e) {
                console.error('Invalid JSON Schema string, falling back to basic json mode.', e);
                formatStr = "json";
              }
            } else {
              formatStr = "json";
            }
          }

          if (s.truncateHistory !== undefined) {
            truncateHist = s.truncateHistory;
          }
        }
      } catch (err) { }

      //console.log('Sending payload:', conversationPayload, 'Options:', inferenceOptions, 'KeepAlive:', keepAliveStr, 'Thinking:', thinking);

      let attemptThinking: boolean | undefined = thinking;
      let attempts = 0;

      while (attempts < 2) {
        try {
          const stream = this.api.sendMessage(
            this.selectedModel(),
            conversationPayload,
            inferenceOptions,
            keepAliveStr,
            attemptThinking,
            formatStr,
            truncateHist,
            controller.signal
          );

          for await (const chunk of stream) {
            if (chunk.content) {
              assistantMsg.content += chunk.content;
              this.messages.update(m => [...m]);
              this.scrollToBottom();
            }
          }
          break; // Success! Break out of the retry loop.
        } catch (e: any) {
          if (e.name === 'AbortError' || (e.message && e.message.includes('aborted'))) {
            console.log('Stream successfully aborted by the user.');
            assistantMsg.content += ' *[Generation stopped]*';
            this.messages.update(m => [...m]);
            break; // Break out of retry loop
          }
          attempts++;

          // Self-heal: If the model doesn't support thinking, automatically strip the think parameter and try again!
          if (attempts === 1 && attemptThinking !== undefined && e.message && e.message.includes('does not support thinking')) {
            console.warn('Selected model does not support reasoning. Automatically retrying with "think" parameter omitted.');
            assistantMsg.content = ''; // Clear prior content
            attemptThinking = undefined; // Drop the thinking parameter
            continue; // Re-attempt connection
          } else {
            console.error(e);
            assistantMsg.content = `[Error: ${e.message}]`;
            this.messages.update(m => [...m]);
            this.scrollToBottom();
            break;
          }
        }
      }

      // If this is a new chat, generate an ID (only on successful completion)
      if (assistantMsg.content && !assistantMsg.content.startsWith('[Error:')) {
        if (this.chatId() === 'new') {
          const newId = 'chat_' + Math.random().toString(36).substring(2, 9);
          this.chatId.set(newId);
          this.router.navigate(['/c', newId], { replaceUrl: true });
        }
        this.saveChatHistory();
      }

    } catch (outerErr: any) {
      console.error('Outer handler error:', outerErr);
      assistantMsg.content = `[Error: ${outerErr.message}]`;
      this.messages.update(m => [...m]);
      this.scrollToBottom();
    } finally {
      this.activeAbortController.set(null);
      this.isStreaming.set(false);
    }
  }

  navigateToSettings() {
    this.router.navigate(['/settings']);
  }
}
