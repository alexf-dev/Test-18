import {Component, inject, Input, OnChanges, OnDestroy, OnInit, SimpleChanges} from '@angular/core';
import {HttpErrorResponse} from "@angular/common/http";
import {finalize, map, of, Subscription} from "rxjs";
import {DomSanitizer, SafeResourceUrl} from "@angular/platform-browser";
import {
    DocumentCard,
    MessageDto,
    OutputDocumentsService,
    OutputSection,
    ReportDto,
    TemplateDto
} from "../../../core/service/output.service";
import {TableLazyLoadEvent} from "primeng/table";

@Component({
    selector: 'app-output-documents',
    templateUrl: './output-documents.component.html',
    styleUrl: './output-documents.component.css'
})
export class OutputDocumentsComponent implements OnChanges, OnInit, OnDestroy {
    @Input({required: true}) patientId: number | null | undefined = null;
    @Input() showSidebar = true;
    section: OutputSection = 'current';
    readonly sections: { id: OutputSection; label: string }[] = [
        {id: 'current', label: 'Выходные документы'},
        {id: 'archive', label: 'Архивные формы документов'},
        {id: 'messages', label: 'СМС сообщений/ извещение направленные услугополучателю'}
    ];
    documents: DocumentCard[] = [];
    messages: MessageDto[] = [];
    selected = new Set<number>();
    viewMode: 'grid' | 'list' = 'grid';
    selectedFiles: DocumentCard[] = [];
    currentPdfIndex = 0;
    loadingPdf = false;
    pdfError = '';
    messageFirst = 0;
    messageRows = 5;
    messageTotal = 0;
    loading = false;
    busy = false;
    error = '';
    dialogVisible = false;
    pdfUrl?: SafeResourceUrl;
    private api = inject(OutputDocumentsService);
    private sanitizer = inject(DomSanitizer);
    private dataRequest?: Subscription;
    private reportsRequest?: Subscription;
    private fileRequest?: Subscription;
    private previewRequest?: Subscription;
    private objectUrl?: string;
    private initialized = false;
    private catalog: TemplateDto[] | null = null;
    private savedReports: ReportDto[] = [];
    private previewContext: { examinationId: number; archive: boolean } | null = null;
    private previewBlobs = new Map<number, Blob>();

    get title() {
        return this.section === 'archive' ? 'Архивные формы документов' : 'Выходные документы';
    }

    get allSelected() {
        return this.documents.length > 0 && this.selected.size === this.documents.length;
    }

    get partiallySelected() {
        return this.selected.size > 0 && !this.allSelected;
    }

    get hasExamination() {
        return this.validExaminationId !== null;
    }

    get currentPdf(): DocumentCard | undefined {
        return this.selectedFiles[this.currentPdfIndex];
    }

    private get validExaminationId(): number | null {
        const id = this.patientId;
        return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
    }

    ngOnInit() {
        this.initialized = true;
        this.load();
    }

    ngOnChanges(changes: SimpleChanges) {
        if (changes['examinationId'] && this.initialized) {
            this.messageFirst = 0;
            this.load();
        }
    }

    changeSection(section: OutputSection) {
        if (this.section === section) return;
        this.section = section;
        this.messageFirst = 0;
        this.load();
    }

    load(forceTemplates = false) {
        this.dataRequest?.unsubscribe();
        this.reportsRequest?.unsubscribe();
        this.fileRequest?.unsubscribe();
        this.loading = false;
        this.busy = false;
        this.closePdf();
        this.selected = new Set();
        this.error = '';
        this.documents = [];
        this.messages = [];
        this.messageTotal = 0;
        this.savedReports = [];
        if (forceTemplates) this.catalog = null;
        const id = this.validExaminationId;
        if (this.section === 'current') {
            this.loading = true;
            this.dataRequest = (this.catalog ? of(this.catalog) : this.api.templates()).pipe(finalize(() => this.loading = false)).subscribe({
                next: templates => {
                    this.catalog = templates;
                    this.buildCurrentCards();
                }, error: error => this.showError(error)
            });
            if (id !== null) this.refreshCurrentReports(id);
        } else if (id !== null) {
            this.loading = true;
            if (this.section === 'archive') this.dataRequest = this.api.reports(id).pipe(finalize(() => this.loading = false)).subscribe({
                next: reports => this.documents = reports.map(report => ({id: report.id, templateId: report.templateId, title: this.name(report), generatedAt: report.createdAt, filename: report.filename})), error: error => this.showError(error)
            });
            else this.dataRequest = this.api.messages(id, this.messageFirst / this.messageRows, this.messageRows).pipe(finalize(() => this.loading = false)).subscribe({
                next: page => {
                    this.messages = page.content;
                    this.messageTotal = page.totalElements;
                }, error: error => this.showError(error)
            });
        }
    }

    paginateMessages(event: TableLazyLoadEvent) {
        const first = event.first ?? 0, rows = event.rows ?? 5;
        if (first === this.messageFirst && rows === this.messageRows) return;
        this.messageFirst = first;
        this.messageRows = rows;
        this.load();
    }

    toggleAll(checked: boolean) {
        if (!this.hasExamination || this.loading || this.busy) return;
        this.selected = checked ? new Set(this.documents.map(d => d.id)) : new Set();
    }

    toggleCard(id: number) {
        if (!this.hasExamination || this.loading || this.busy) return;
        const next = new Set(this.selected);
        next.has(id) ? next.delete(id) : next.add(id);
        this.selected = next;
    }

    preview() {
        const examinationId = this.validExaminationId;
        if (examinationId === null || !this.selected.size || this.busy || this.loading || this.section === 'messages') return;
        const files = this.documents.filter(doc => this.selected.has(doc.id)).map(doc => ({...doc}));
        if (!files.length) return;
        this.closePdf();
        this.error = '';
        this.selectedFiles = files;
        this.previewContext = {examinationId, archive: this.section === 'archive'};
        this.dialogVisible = true;
        this.loadSelectedPdf();
    }

    loadSelectedPdf() {
        const context = this.previewContext, doc = this.selectedFiles[this.currentPdfIndex];
        if (!context || !doc || !this.dialogVisible) return;
        this.previewRequest?.unsubscribe();
        this.clearPdfUrl();
        this.pdfError = '';
        const cached = this.previewBlobs.get(doc.id);
        if (cached) {
            this.loadingPdf = false;
            this.setPdf(cached);
            return;
        }
        this.loadingPdf = true;

        const body = {
            templateId: doc.id,
            saveType: 3,
            params: {id: doc.id},
            internalParams: {
                patientId: {
                    value: String(this.patientId),
                    type: 'java.lang.Long'
                }
            }
        };

        this.previewRequest = this.api.generateDocument(body)
            .pipe(
                map(response => {
                    if (!response.content) {
                        throw new Error('Содержимое PDF отсутствует');
                    }

                    const base64 = response.content
                        .replace(/^data:[^,]*;base64,/i, '')
                        .replace(/\s/g, '');

                    const binary = atob(base64);
                    const bytes = Uint8Array.from(
                        binary,
                        char => char.charCodeAt(0)
                    );

                    return new Blob([bytes], {
                        type: 'application/pdf'
                    });
                }),
                finalize(() => {
                    this.loadingPdf = false;
                })
            )
            .subscribe({
                next: blob => {
                    this.previewBlobs.set(doc.id, blob);
                    this.setPdf(blob);

                    if (!context.archive) {
                        this.refreshCurrentReports(context.examinationId);
                    }
                },
                error: error => {
                    this.pdfError = this.errorMessage(error);
                }
            });
    }

    prevPdf() {
        if (this.currentPdfIndex > 0) {
            this.currentPdfIndex--;
            this.loadSelectedPdf();
        }
    }

    nextPdf() {
        if (this.currentPdfIndex < this.selectedFiles.length - 1) {
            this.currentPdfIndex++;
            this.loadSelectedPdf();
        }
    }

    download() {
        const examinationId = this.validExaminationId, ids = Array.from(this.selected);
        if (examinationId === null || !ids.length || this.busy || this.loading || this.section === 'messages') return;
        const archive = this.section === 'archive';
        this.busy = true;
        this.error = '';
        this.fileRequest = this.api.download(examinationId, ids, archive).pipe(finalize(() => this.busy = false)).subscribe({
            next: blob => {
                const url = URL.createObjectURL(blob), link = document.createElement('a');
                link.href = url;
                link.download = `${archive ? 'reports' : 'documents'}-${examinationId}.${ids.length === 1 ? 'pdf' : 'zip'}`;
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                if (!archive) this.refreshCurrentReports(examinationId);
            }, error: error => this.showError(error)
        });
    }

    closePdf() {
        this.dialogVisible = false;
        this.previewRequest?.unsubscribe();
        this.loadingPdf = false;
        this.pdfError = '';
        this.clearPdfUrl();
        this.selectedFiles = [];
        this.currentPdfIndex = 0;
        this.previewContext = null;
        this.previewBlobs.clear();
    }

    ngOnDestroy() {
        this.dataRequest?.unsubscribe();
        this.reportsRequest?.unsubscribe();
        this.fileRequest?.unsubscribe();
        this.closePdf();
    }

    private name(item: { id: number; nameRu: string | null; nameKz: string | null; code: string | null }) {
        return item.nameRu?.trim() || item.nameKz?.trim() || item.code || `Документ #${item.id}`;
    }

    private buildCurrentCards() {
        const latest = new Map<number, ReportDto>();
        for (const report of this.savedReports) {
            const previous = latest.get(report.templateId);
            if (!previous || previous.id < report.id) latest.set(report.templateId, report);
        }
        this.documents = (this.catalog ?? []).map(template => {
            const report = latest.get(template.id);
            return {id: template.id, templateId: template.id, title: this.name(template), generatedAt: report?.createdAt ?? null, filename: report?.filename ?? null};
        });
    }

    private refreshCurrentReports(id: number) {
        this.reportsRequest?.unsubscribe();
        this.reportsRequest = this.api.reports(id).subscribe({
            next: reports => {
                this.savedReports = reports;
                this.buildCurrentCards();
            }, error: error => this.showError(error)
        });
    }

    private setPdf(blob: Blob) {
        this.clearPdfUrl();
        this.objectUrl = URL.createObjectURL(blob);
        this.pdfUrl = this.sanitizer.bypassSecurityTrustResourceUrl(this.objectUrl);
    }

    private clearPdfUrl() {
        this.pdfUrl = undefined;
        if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
        this.objectUrl = undefined;
    }

    private errorMessage(error: HttpErrorResponse) {
        return error.status === 401 || error.status === 403 ? 'Недостаточно прав для загрузки данных.' : error.status === 404 ? 'Освидетельствование или документ не найдены.' : error.status === 409 ? 'Шаблон недоступен или не заполнен. Обновите список документов.' : error.status === 502 ? 'Не удалось получить PDF из хранилища. Обратитесь к администратору.' : error.status === 0 ? 'Нет соединения с сервером. Проверьте запуск backend.' : 'Не удалось загрузить данные. Попробуйте ещё раз.';
    }

    private showError(error: HttpErrorResponse) {
        this.error = this.errorMessage(error);
    }
}
