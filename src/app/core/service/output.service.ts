import {inject, Injectable} from "@angular/core";
import {HttpClient} from "@angular/common/http";
import {map, Observable} from "rxjs";
import {GeneratedDocumentResponse} from "./completed-work-acts.service";
import {ApiService} from "../api.service";

export type OutputSection='current'|'archive'|'messages';
export interface TemplateDto {id:number;code:string|null;nameRu:string|null;nameKz:string|null;sortOrder:number;}
export interface ReportDto {id:number;examinationId:number;templateId:number;nameRu:string|null;nameKz:string|null;code:string|null;filename:string;sizeBytes:number;createdAt:string;}
export interface MessageDto {id:number;sentAt:string;type:string;text:string;status:'DELIVERED'|'ERROR'|'PENDING';progress:number;}
export interface Page<T> {content:T[];totalElements:number;page:number;size:number;}
export interface DocumentCard {id:number;templateId:number;title:string;generatedAt:string|null;filename:string|null;}

@Injectable({providedIn:'root'})
export class OutputDocumentsService {

  constructor(private api: ApiService) {
  }
  private http=inject(HttpClient);
  private readonly apiUrl='http://localhost:8080/api';
  private documentsUrl(examinationId:number){return `${this.apiUrl}/examinations/${examinationId}/output-documents`;}
  private reportsUrl(examinationId:number){return `${this.apiUrl}/examinations/${examinationId}/reports`;}
  templates(){return this.api.get<TemplateDto[]>(`/api/examination/output-documents`);}
  reports(examinationId:number){return this.http.get<ReportDto[]>(this.reportsUrl(examinationId));}
  messages(examinationId:number,page:number,size:number){return this.http.get<Page<MessageDto>>(this.documentsUrl(examinationId)+'/messages',{params:{page,size}});}
  pdf(examinationId:number,ids:number[],archive:boolean):Observable<Blob>{
    return archive?this.http.post(this.reportsUrl(examinationId)+'/preview',{reportIds:ids},{responseType:'blob'}):this.http.post(this.documentsUrl(examinationId)+'/preview',{templateIds:ids},{responseType:'blob'});
  }
  download(examinationId:number,ids:number[],archive:boolean):Observable<Blob>{
    return archive?this.http.post(this.reportsUrl(examinationId)+'/download',{reportIds:ids},{responseType:'blob'}):this.http.post(this.documentsUrl(examinationId)+'/download',{templateIds:ids},{responseType:'blob'});
  }
  generateDocument(
      body: Record<string, unknown>
  ): Observable<GeneratedDocumentResponse> {
      return this.api.post(
          '/api/document-generation/internal/v1/generateDocument',
          body
      );
  }
}
