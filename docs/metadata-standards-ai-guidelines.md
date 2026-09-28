# Metadata Standards — AI Engineering Guidelines (DDI-L 3.3 · GSIM 2.0 · GSBPM 5.2 · SDC · RBAC/ACL)

> **Đối tượng đọc:** AI coding agent (Claude Code, Junie, Copilot…) và dev khi **làm task mới** hoặc **clone/tiếp nhận code** trong hệ thống metadata thống kê (NSO-SMR / CSDL Đặc tả & Vi mô).
> **Phiên bản:** 1.0 · 2026-09-25 · Tác giả tổng hợp: MinhDN39 (+ AI research)
> **Tính chất:** Tài liệu **opt-in theo module**. AI **không được** tự áp dụng khi user chưa chọn (xem §1).

## Mục lục

- §0 Quy ước nhãn & mức bắt buộc
- §1 Giao thức kích hoạt (AI PHẢI đọc trước)
- §2 Danh mục module & quyết định có lựa chọn
- §3 Thuật ngữ & mapping GSIM ↔ DDI-L ↔ SDMX
- §4 CORE — Định danh, phiên bản, tái sử dụng
- §5 DDI — DDI Lifecycle 3.3
- §6 GSIM — Mô hình khái niệm & Variable cascade
- §7 CLS — Classification & CodeList
- §8 GSBPM — Metadata-driven production & truy vết
- §9 SDC — Bảo mật & kiểm soát tiết lộ
- §10 AUTHZ — RBAC + object-level ACL
- §11 NSO — Ràng buộc riêng dự án NSO-SMR
- §12 Quy trình khi clone / tiếp nhận code
- §13 Checklist review PR
- §14 Câu hỏi mở & điểm chưa xác minh
- §15 Nguồn

---

## §0. Quy ước nhãn & mức bắt buộc

| Nhãn | Nghĩa |
|---|---|
| **MUST** | Bắt buộc khi module được bật. Muốn lệch → ghi *comply-or-explain* (§1.5). |
| **SHOULD** | Khuyến nghị mạnh; lệch được nếu có lý do ghi trong ADR/PR. |
| **MAY** | Tuỳ chọn. |
| `[Src: …]` | Có nguồn trực tiếp (xem §15). |
| `[Inference]` | Suy luận từ nguồn, chưa có câu chữ trực tiếp. |
| `[Unverified]` | Chưa xác minh được — phải kiểm tra trước khi dựa vào. |
| `[Decision Dx]` | Phụ thuộc lựa chọn của user ở §2.2. |

Mã nguyên tắc: `<MODULE>-<số>` (vd `CORE-03`). Dùng mã này trong commit/PR review, **không** dùng trong tên class/comment code (giải thích invariant trực tiếp).

---

## §1. Giao thức kích hoạt (AI PHẢI đọc trước)

### 1.1 Khi nào chạy giao thức

AI chạy §1.2 khi **bất kỳ** điều kiện nào đúng:
- Bắt đầu task mới liên quan metadata/thống kê/microdata/danh mục/phân quyền dữ liệu.
- Clone hoặc tiếp nhận một repo mới.
- User gõ `--metadata-standards` hoặc nhắc tới DDI/GSIM/GSBPM/SDMX/SDC.

Task **không liên quan** (UI thuần, build script, tài liệu chung) → bỏ qua tài liệu này.

> **aidev** (`claude-sdlc-agents`) tự đọc `.metadata-standards.yml` của project đích và không hỏi user. Không có file → không áp dụng. Có file → chỉ gửi §0, §2, §3, §13 và các mục của module được bật. Không gửi §1 và §12. Xem mục "Metadata standards" trong README của aidev.

### 1.2 Tra cấu hình

1. Tìm file `.metadata-standards.yml` ở root repo.
2. **Có file** → áp dụng đúng module/quyết định trong đó. Không hỏi lại.
3. **Không có file** → hỏi user bằng `AskUserQuestion` (mẫu §1.3). **Không đoán.**
4. User chọn xong → đề xuất tạo `.metadata-standards.yml` (mẫu §1.4). Chỉ ghi file khi user đồng ý.
5. User chọn `none` → không áp dụng gì, không nhắc lại trong phiên.

### 1.3 Mẫu câu hỏi cho AI

Trước khi hỏi, AI phải in ra bảng tóm tắt module (§2.1) để user thấy phân tích. Sau đó:

```text
Q1 (single) "Áp dụng bộ nguyên tắc metadata nào cho repo này?"
  - Full NSO-SMR (Recommended)  → CORE+DDI+GSIM+CLS+GSBPM+SDC+AUTHZ+NSO
  - Chuẩn quốc tế, không ràng buộc dự án → CORE+DDI+GSIM+CLS+GSBPM
  - Chỉ bảo mật & phân quyền      → CORE+SDC+AUTHZ
  - Không áp dụng                 → none
Q2 (multi, chỉ hỏi nếu user chọn "Other"/tuỳ chỉnh) "Chọn module:" CORE, DDI, GSIM, CLS, GSBPM, SDC, AUTHZ, NSO
Q3 (single) "Mức áp dụng?"
  - Strict: MUST chặn merge, SHOULD cảnh báo (Recommended cho code mới)
  - Advisory: chỉ báo cáo gap, không chặn (Recommended cho code clone/legacy)
```

Các quyết định D1–D8 (§2.2): dùng **giá trị mặc định** trừ khi task chạm trực tiếp vào quyết định đó — lúc đó mới hỏi riêng.

### 1.4 Mẫu `.metadata-standards.yml`

```yaml
# Cấu hình áp dụng docs/metadata-standards-ai-guidelines.md
guideline_version: "1.0"
mode: strict            # strict | advisory
modules: [CORE, DDI, GSIM, CLS, GSBPM, SDC, AUTHZ, NSO]
decisions:
  D1_canonical_model: gsim-canonical      # gsim-canonical | ddi-native
  D2_version_format: semver-overlay       # semver-overlay | integer-revision
  D3_trace_store: relational-closure      # relational-closure | graph | pending-poc
  D4_rule_language: pending-poc           # vtl | native-pseudo-vtl | pending-poc
  D5_authz_impl: spring-security-acl      # spring-security-acl | custom-permission-table | rbac-only
  D6_permission_inheritance: tree-fallback # tree-fallback | independent-matrices
  D7_population_entity: separate          # separate | ddi-universe-extended
  D8_id_strategy: agency-uuid             # agency-uuid | maintainable-scoped
  D9_sdc_thresholds: international        # international (OCG rule-of-thumb) | custom
agency: "vn.gso"        # user xác nhận 2026-09-25
stack: {frontend: reactjs, backend: spring-boot, db: postgresql}  # đã chốt 2026-09-25
waivers: []             # comply-or-explain: [{rule: CORE-05, reason: "...", owner: "...", until: "2026-12-31"}]
```

### 1.5 Comply-or-explain

Khi code **không thể** tuân một rule MUST: thêm mục vào `waivers` (rule, lý do, owner, hạn) và nêu trong PR. AI **không tự** thêm waiver mà phải hỏi user. `[Src: DK-GOV slide 10-11]`

### 1.6 Ranh giới hành vi AI

- Áp dụng **chỉ** module đã bật. Không mở rộng scope sang module khác.
- Code legacy (mode advisory): báo cáo gap, **không** refactor hàng loạt khi chưa được duyệt.
- Không bịa tên phần tử DDI/GSIM. Tên chưa kiểm chứng → đánh dấu `[Unverified]` và đối chiếu XSD/model web trước khi dùng (NSO-15).
- Không đảo ngược các quyết định đã chốt ở §11.2.

---

## §2. Danh mục module & quyết định có lựa chọn

### 2.1 Module

| Module | Nội dung | Phụ thuộc | Khi nào bật |
|---|---|---|---|
| **CORE** | Định danh Agency/ID/Version, URN, bất biến sau publish, reference early/late binding, đa ngôn ngữ | — | Mọi hệ thống quản lý metadata có phiên bản |
| **DDI** | Tuân thủ DDI-L 3.3: Identifiable/Versionable/Maintainable, Schemes, packages, Question/Instrument, Physical/Logical | CORE | Xuất/nhập DDI XML, hoặc mô hình dữ liệu vi mô |
| **GSIM** | Canonical model GSIM 2.0, variable cascade, Population/UnitType, tách design/runtime | CORE | Thiết kế domain model lõi |
| **CLS** | CodeList vs StatisticalClassification, version/correspondence, typology thay đổi | CORE | Danh mục, bảng phân loại (VSIC, VSCO…) |
| **GSBPM** | Metadata-driven production, truy vết, run pinning, quality gate | CORE | Workflow sản xuất, tích hợp hệ vệ tinh |
| **SDC** | Bảo mật vi mô, pseudonymisation, output checking, four-eyes | — | Có microdata hoặc bảng tổng hợp từ vi mô |
| **AUTHZ** | RBAC global + object-level permission | — | Có chia sẻ/phân quyền theo đối tượng |
| **NSO** | Scope, won't-have, thứ tự build, quyết định đã chốt của NSO-SMR | CORE, GSIM | Chỉ repo thuộc dự án NSO-SMR |

### 2.2 Quyết định có lựa chọn (D1–D8)

| # | Quyết định | Phương án | Mặc định & lý do |
|---|---|---|---|
| D1 | Canonical model | **(a) gsim-canonical**: lõi theo GSIM 2.0, DDI/SDMX là adapter ở biên · (b) ddi-native: bảng lõi theo DDI-L | (a) — đã chốt trong WP-03 §3.1. (b) xuất hiện ở pptx NSO-Metadata-DWH slide 4 và ToR mission Đan Mạch, `[Unverified]` là quyết định chính thức. |
| D2 | Định dạng version | **(a) semver-overlay** `major.minor.patch` · (b) integer-revision | (a) cho NSO (proposal v1.2 §5.2). DDI chỉ yêu cầu các số nguyên nối bằng dấu chấm, nên cả hai đều hợp lệ với DDI. `[Src: TG p.31; BP p.6]` |
| D3 | Trace store | (a) quan hệ + closure table/recursive CTE · (b) graph DB · (c) chờ PoC | (a) để bắt đầu nhưng **phải** ẩn sau interface `TraceRepository`. Kiến trúc ghi là "chờ PoC G1" (Q2). |
| D4 | Biểu diễn Rule | (a) VTL · (b) native + pseudo-VTL · (c) chờ PoC | (c). Không hardcode ngôn ngữ rule (Q3). |
| D5 | Cài đặt AuthZ | **(a) `spring-security-acl`** 4 bảng chuẩn · (b) bảng `object_permission` + custom `PermissionEvaluator` · (c) RBAC thuần | **(a) — user đã chốt 2026-09-25.** Khi nâng cấp Spring Security major, đọc release notes phần ACL `[Unverified: tình trạng deprecation]`. |
| D6 | Kế thừa quyền | **(a) tree-fallback** Collection→Study→Dataset→Variable · (b) 2 ma trận độc lập (kiểu WB Editor) | (a), hiện thực bằng `parent_object` + `entries_inheriting` của Spring ACL. Có thể chuyển sang (b) nếu BA yêu cầu. `[Inference]` |
| D9 | Ngưỡng SDC | **(a) international**: rule-of-thumb của Output-checking guidelines · (b) custom | **(a) — user đã chốt 2026-09-25.** Giá trị vẫn đặt trong cấu hình mật, không hardcode. |
| D7 | Population | **(a) entity riêng** (GSIM) · (b) dùng Universe mở rộng time/geo (DDI-L) | (a) trong lõi; khi xuất DDI thì map sang Universe + TimePeriod/Location. `[Src: Web:Universe]` |
| D8 | Chiến lược ID | **(a) UUID, unique trong agency** · (b) ID phân cấp `MaintainableID.ObjectID` | (a). `[Src: BP p.4-7]` |

---

## §3. Thuật ngữ & mapping GSIM ↔ DDI-L ↔ SDMX

> Mapping dưới đây **không phải bảng chính thức của UNECE**. GSIM 2.0 Principle 14 nói rõ tài liệu mapping nằm ngoài GSIM. Bảng tổng hợp từ case Statistics Denmark và định nghĩa gốc. `[Src: GSIM-UG p.35; DK-2016]`

| GSIM 2.0 | DDI-L 3.3 | SDMX 3.x | Lưu ý |
|---|---|---|---|
| Identifiable Artefact | Identifiable/Versionable/Maintainable | Identifiable/MaintainableArtefact | GSIM lấy thuật ngữ từ SDMX |
| Concept | Concept | Concept | ~1-1 |
| Unit Type | UnitType | — | |
| Universe / Population | Universe (có thể kèm time/geo) | — | DDI-L **không** có class Population. Map máy móc sẽ lặp lỗi mà DK đã ghi nhận `[Src: DK-2016 p.382]` |
| Conceptual Variable | ConceptualVariable | — | |
| Represented Variable | RepresentedVariable | Concept + Representation | |
| Instance Variable | Variable | Component trong DSD | |
| Value Domain (enumerated/described) | CodeList / NumericDomain… | Codelist / TextFormat | Tên domain DDI cụ thể cần đối chiếu XSD `[Unverified]` |
| Statistical Classification | StatisticalClassification (mới ở 3.3) | Codelist (+Hierarchy) | Mapping phức tạp nhất |
| Correspondence Table / Map | ClassificationCorrespondenceTable / ClassificationMap | Structure/Representation Map | |
| Data Set | PhysicalInstance / LogicalProduct | Dataset | |
| Data Structure (Identifier/Measure/Attribute) | DataRelationship / LogicalRecord + roles | DSD (Dimension/Measure/Attribute) | |
| Referential Metadata Set | Quality/Other material | Reference Metadata / MSD (SIMS) | |
| Process Design / Step | ControlConstruct, ProcessingEvent (một phần) | — | Xem thêm GSBPM |

Các khái niệm hay bị nhầm:
- **Code** chỉ là ký hiệu, không mang nghĩa. **Category** mới mang nghĩa. **CodeList** = tập Code gắn với Category. `[Src: DDITL_08 s3-5]`
- **Data Point** là ô chứa (cấu trúc). **Datum** là giá trị thực tế. `[Src: GSIM-UG p.22]`
- **Structural metadata** bắt buộc đi kèm dữ liệu. **Reference metadata** mô tả phương pháp/chất lượng. `[Src: HB-11.4]`

---

## §4. CORE — Định danh, phiên bản, tái sử dụng

| Mã | Mức | Nguyên tắc | Kiểm tra | Nguồn |
|---|---|---|---|---|
| CORE-01 | MUST | Mọi artefact quản trị có bộ 3 `agency` + `artefact_id` + `version`, unique cùng nhau. `artefact_id` giữ nguyên qua các version. | Có unique constraint `(agency, artefact_id, version)` | TG p.33-34; BP 4.1 |
| CORE-02 | MUST | URN canonical `urn:ddi:{agency}:{id}:{version}`. Object lồng dùng `{parentId}.{childId}` nếu scope=Maintainable. Lưu **cả** 4 phần (agency, id, version, urn), không chỉ URN. | URN sinh từ 3 trường, không nhập tay | TG p.34; BP 5.6 |
| CORE-03 | MUST | ID sinh bằng UUID (D8), không dùng auto-increment làm định danh nghiệp vụ. | Không lộ PK DB ra API làm ID nghiệp vụ | BP 4.4 |
| CORE-04 | MUST | **Bất biến sau publish**: version đã publish không được sửa payload. Sửa = tạo version mới + `versionRationale` bắt buộc. | Guard ở service **và** DB trigger | TG p.31; proposal v1.2 §5.2 |
| CORE-05 | MUST | Tách **administrative** fields (note nội bộ, tag, audit, userId) khỏi **payload**. Chỉ payload đổi mới bump version. | Danh sách field payload khai báo tường minh | TG p.45 §5.4 |
| CORE-06 | MUST | Reference ghi rõ binding: **early** (ghim version) hoặc **late** (mới nhất, có thể giới hạn major). Mặc định early. Dữ liệu đã công bố/run log luôn early. | Kiểu `ArtefactRef` có `lateBound` | TG p.33, 43-44 |
| CORE-07 | SHOULD | Sửa con được cha tham chiếu early-bound → đánh giá bump version cha (versioning lan lên cây chứa). | Impact analysis trước khi publish | TG p.31; DDITL_09 s21 |
| CORE-08 | MUST | Tái sử dụng bằng **reference**, không copy nội dung. Tạo từ object agency khác hoặc thay đổi lớn → object mới + `basedOn`. | Không có bảng trùng định nghĩa | BP 3.1, 4.3; TG p.39 |
| CORE-09 | MUST | Text đa ngôn ngữ có language tag (BCP 47/ISO 639-1) **tại từng giá trị**, có sẵn ở schema từ MVP. | Bảng `*_text(lang, value)` hoặc JSONB `{vi,en}` | BP 5.4; proposal v1.2 TĐ-3 |
| CORE-10 | SHOULD | Mở rộng ngoài chuẩn dùng key-value kiểu `UserAttributePair`. Không lạm dụng field sẵn có. | — | BP 5.2 |
| CORE-11 | SHOULD | Rich text: lưu Markdown/escaped + cờ `isPlainText`, không nhúng HTML vào schema. | — | BP 5.5 |
| CORE-12 | MUST | Controlled vocabulary lưu **code + version CV**, không chỉ label. | Cột `cv_code`, `cv_version` | DDI-CV s16 |
| CORE-13 | SHOULD | Change Event là entity riêng, quan hệ N:N với artefact (hỗ trợ merge/split). | Bảng `change_event_artefact` | GSIM site: Change Event |

### 4.1 Code mẫu (Java / Spring Boot / JPA)

```java
/** Base cho mọi artefact có phiên bản. Payload bất biến khi state = PUBLISHED. */
@MappedSuperclass
public abstract class VersionableArtefact {
    @Id @GeneratedValue private Long pk;                        // PK kỹ thuật, không lộ ra API
    @Column(nullable = false, updatable = false) private String agency;
    @Column(nullable = false, updatable = false) private UUID artefactId;  // ổn định qua các version
    @Column(nullable = false, updatable = false) private String version;   // D2: "1.2.0"
    @Enumerated(EnumType.STRING) private LifecycleState state;  // lớp governance NSO, không ghi vào DDI XML
    private String versionRationale;                             // bắt buộc khi version > 1.0.0
    private String versionResponsibility;
    private Instant versionDate;
    @Embedded private ArtefactRef basedOn;

    public String urn() { return "urn:ddi:%s:%s:%s".formatted(agency, artefactId, version); }
    public boolean isPublished() { return state == LifecycleState.PUBLISHED; } // map sang DDI IsPublished
}

public enum LifecycleState { DRAFT, IN_REVIEW, PUBLISHED, DEPRECATED }

/** Reference tới artefact khác; version = null khi lateBound. */
@Embeddable
public record ArtefactRef(String agency, UUID artefactId, String version,
                          boolean lateBound, String lateBoundMajor, String typeOfObject) {
    public ArtefactRef {
        if (!lateBound && version == null) throw new IllegalArgumentException("early-bound ref cần version");
    }
}
```

```sql
-- Chặn sửa payload của bản đã publish ở tầng DB (PostgreSQL). Chỉ cho phép đổi cột admin.
CREATE OR REPLACE FUNCTION forbid_published_payload_update() RETURNS trigger AS $$
BEGIN
  IF OLD.state = 'PUBLISHED' AND (NEW.payload IS DISTINCT FROM OLD.payload
                                  OR NEW.version IS DISTINCT FROM OLD.version) THEN
    RAISE EXCEPTION 'Artefact % v% đã publish: tạo version mới', OLD.artefact_id, OLD.version;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
-- CREATE TRIGGER trg_variable_immutable BEFORE UPDATE ON represented_variable
--   FOR EACH ROW EXECUTE FUNCTION forbid_published_payload_update();
```

> Nếu payload tách nhiều cột, so sánh từng cột payload thay cho `payload`. Chuyển `PUBLISHED → DEPRECATED` là thay đổi admin, được phép.

---

## §5. DDI — DDI Lifecycle 3.3

| Mã | Mức | Nguyên tắc | Nguồn |
|---|---|---|---|
| DDI-01 | MUST | Phân cấp Identifiable → Versionable → Maintainable. Maintainable = Module (StudyUnit, Group, ResourcePackage, DataCollection, LogicalProduct, PhysicalDataProduct…) hoặc Scheme (ConceptScheme, CategoryScheme, CodeListScheme, VariableScheme, QuestionScheme…). | TG §4.2, §5.2 |
| DDI-02 | MUST | **Không ghi workflow state** (Draft/InReview/Deprecated) vào DDI XML. Chỉ xuất `isPublished` + `Version`/`VersionRationale`/`VersionResponsibility`. | user-stories-ddi33 §1 |
| DDI-03 | MUST | Scheme Group (VariableGroup…) chỉ để phân nhóm hành chính, không thay container chính thức. | TG §4.3 |
| DDI-04 | SHOULD | Trao đổi/API từng item dùng mẫu **FragmentInstance** (item + các item nó tham chiếu). Ưu tiên reference thay vì inline. | BP 3.1 |
| DDI-05 | MUST | Scheme publish trong StudyUnit/Group/ResourcePackage là inline. Tài nguyên dùng chung xuyên study đặt trong **ResourcePackage**. | TG §4.4.3 |
| DDI-06 | MUST | 1 StudyUnit = 1 đợt thu thập phối hợp. Nhiều đợt/kỳ → gom bằng **Group**. Không clone StudyUnit để tái sử dụng. | TG §7.10.3; DDITL_10 s3 |
| DDI-07 | MUST | Tách **LogicalProduct** (Variable, CodeList, LogicalRecord) ↔ **PhysicalDataProduct** (layout) ↔ **PhysicalInstance** (1 file: fingerprint, summary). Nên dùng DataRelationshipReference thay vì mô tả layout chi tiết. | TG §7.4; BP 5.3 |
| DDI-08 | MUST | Question content (QuestionItem/Grid/Block) tách khỏi flow (ControlConstruct). IfThenElse/Loop/RepeatUntil/RepeatWhile **chỉ trỏ tới Sequence**. QuestionBlock chỉ dùng khi có StimulusMaterial chung. | TG §7.3; BP 5.1 |
| DDI-09 | SHOULD | Đo lường phi khảo sát (thiết bị, dữ liệu hành chính) dùng MeasurementItem. | TG §7.3 |
| DDI-10 | MUST | Variable không có ConceptReference (trực tiếp hoặc qua RepresentedVariable) là không tuân ISO/IEC 11179 → validation phải cảnh báo. | TG §3.4 |
| DDI-11 | MUST | Tách 3 loại quality: MetadataQuality (của metadata), QualityStatement (quy trình), Data quality (số liệu). | TG §6.9; DDITL_12 |
| DDI-12 | MUST | Tên element/attribute DDI dùng trong code phải khớp nguyên văn XSD 3.3 (`DDI_3_3_2020-04-15_Documentation_XMLSchema.zip`). | NSO-15 |
| DDI-13 | SHOULD | Công bố chính sách version của tổ chức (`VersionDistinction` trong OrganizationScheme). | TG p.31 |

Ghi chú:
- DDI-L 3.3 không có trạng thái "deprecated" chuẩn. Việc rút lại một item làm qua version mới + `Note`. `[Inference, TG §6.6]`
- Nếu cần tách class Population riêng thì đó là hướng của DDI-CDI, `[Unverified]` — tài liệu này chưa đọc spec DDI-CDI.

---

## §6. GSIM — Mô hình khái niệm & Variable cascade

| Mã | Mức | Nguyên tắc | Nguồn |
|---|---|---|---|
| GSIM-01 | MUST (D1=a) | Domain model lõi theo GSIM 2.0 (5 group: Base, Business, Concepts, Exchange, Structures). Khái niệm riêng của DDI/SDMX (Dataflow, FragmentInstance…) **không** rò vào lõi. Chỉ ở adapter. | GSIM-UG P14; WP-03 §3.1 |
| GSIM-02 | MUST | Variable cascade 4 tầng, **bảng riêng + FK**: `Concept → ConceptualVariable (+UnitType) → RepresentedVariable (+ValueDomain) → InstanceVariable (trong DataSet)`. Không gộp 1 bảng `variable` với cột nullable. | GSIM-UG p.16-17; TG §7.4.1 |
| GSIM-03 | MUST | Không có FK tắt InstanceVariable → ConceptualVariable (bỏ qua RepresentedVariable). | DK-2016 p.387 |
| GSIM-04 | MUST | InstanceVariable chỉ lưu phần **thu hẹp/khác biệt** (universe hẹp hơn, top-code, `localId` = tên cột), không định nghĩa lại concept/representation. | TG p.60-61, 105-108 |
| GSIM-05 | MUST | `UnitType` (không time/geo) → `Universe` (không time/geo) → `Population` (có `geography` + `referencePeriod`) là entity riêng (D7). Không dùng cột text tự do. | GSIM site; unit-type slides |
| GSIM-06 | MUST | Value Domain tách **Substantive** và **Sentinel**. Dùng bộ mã sentinel chung toàn hệ thống (vd `S_X` không xác định, `S_Z` không áp dụng, `S_R` từ chối, `S_U` không biết). | GSIM site: Sentinel Value Domain |
| GSIM-07 | MUST | Tách **design-time** (ProcessDesign, StatisticalProgramDesign) khỏi **runtime** (ProcessStepInstance, ExecLog) — bảng riêng. | GSIM-UG Principle 5 |
| GSIM-08 | MUST | Data Structure có component role rõ ràng: Identifier / Measure / Attribute. Attribute có `attachmentLevel` (DataSet/Series/Group/Observation) tường minh. | GSIM site: Attribute Component |
| GSIM-09 | MUST | `id` (toàn cục) ≠ `localId` (tên trong ngữ cảnh, vd tên cột). | GSIM site: Identifiable Artefact |
| GSIM-10 | SHOULD | Referential Metadata Structure cấu hình được theo loại subject (Programme, DataSet, Classification…). Không hardcode 1 schema quality report. | GSIM-UG §3.11 |
| GSIM-11 | SHOULD | Metadata phải **liên kết** (variable → concept, classification, unit of measure, population, dataset, output), không để text rời rạc. | DK-GOV slide 7 |
| GSIM-12 | SHOULD | Agent gồm Individual / Organisation / **Software Agent**. Quy vai trò qua `AgentInRole` (Owner, Maintainer, Contact). | GSIM site: Agent |

### 6.1 DDL mẫu (PostgreSQL, rút gọn — cột Versionable chung lược bỏ)

```sql
CREATE TABLE concept              (pk bigserial PRIMARY KEY, artefact_id uuid, version text, name jsonb NOT NULL, definition jsonb);
CREATE TABLE unit_type            (pk bigserial PRIMARY KEY, artefact_id uuid, version text, concept_pk bigint REFERENCES concept);
CREATE TABLE universe             (pk bigserial PRIMARY KEY, artefact_id uuid, version text, unit_type_pk bigint NOT NULL REFERENCES unit_type,
                                   parent_universe_pk bigint REFERENCES universe);                     -- SubUniverse
CREATE TABLE population           (pk bigserial PRIMARY KEY, artefact_id uuid, version text, universe_pk bigint NOT NULL REFERENCES universe,
                                   geography_ref text NOT NULL, reference_period daterange NOT NULL);  -- chỉ tầng này có time/geo
CREATE TABLE conceptual_variable  (pk bigserial PRIMARY KEY, artefact_id uuid, version text,
                                   concept_pk bigint NOT NULL REFERENCES concept, unit_type_pk bigint NOT NULL REFERENCES unit_type);
CREATE TABLE value_domain         (pk bigserial PRIMARY KEY, artefact_id uuid, version text,
                                   kind text CHECK (kind IN ('ENUMERATED','DESCRIBED')), role text CHECK (role IN ('SUBSTANTIVE','SENTINEL')),
                                   code_list_ref text, classification_ref text, data_type text, expression text);
CREATE TABLE represented_variable (pk bigserial PRIMARY KEY, artefact_id uuid, version text,
                                   conceptual_variable_pk bigint NOT NULL REFERENCES conceptual_variable,
                                   substantive_domain_pk bigint NOT NULL REFERENCES value_domain,
                                   sentinel_domain_pk bigint REFERENCES value_domain);
CREATE TABLE instance_variable    (pk bigserial PRIMARY KEY, artefact_id uuid, version text,
                                   data_set_pk bigint NOT NULL, represented_variable_pk bigint NOT NULL REFERENCES represented_variable,
                                   local_id text NOT NULL,                       -- tên cột trong file
                                   role text CHECK (role IN ('IDENTIFIER','MEASURE','ATTRIBUTE')),
                                   population_pk bigint REFERENCES population,   -- thu hẹp phạm vi
                                   constraint_note jsonb);                       -- chỉ phần khác biệt
-- KHÔNG có cột instance_variable.conceptual_variable_pk (GSIM-03)
```

---

## §7. CLS — Classification & CodeList

| Mã | Mức | Nguyên tắc | Nguồn |
|---|---|---|---|
| CLS-01 | MUST | **CodeList ≠ StatisticalClassification**, entity riêng. CodeList phẳng/gắn survey, có thể có mã missing. Classification là chuẩn quốc gia/quốc tế, phân cấp, item **loại trừ lẫn nhau & bao phủ đủ** trong mỗi Level. | GSIM-UG §3.6; fd-02 FR-010; slide Danh mục s2,4 |
| CLS-02 | MUST | Category (nghĩa) tách khỏi Code (ký hiệu). Một CategoryScheme dùng lại cho nhiều CodeList. | DDITL_08 s9; TG |
| CLS-03 | MUST | Phân cấp: `ClassificationFamily → ClassificationSeries → StatisticalClassification (version) → Level → ClassificationItem`. | TG §7.9; GSIM-UG |
| CLS-04 | MUST | Classification có `current`, `floating`, `isUpdate`, `updatesPossible`, `predecessor`/`successor`, `changesFromPreviousVersion`. | GSIM site |
| CLS-05 | MUST | ClassificationItem có: code, parent, level, includes/includesAlso/excludes, `isGenerated`, `validFrom/validTo`, `changesFromPriorVersion`, successor. | Template_Danhmuc.xlsx |
| CLS-06 | MUST | Đổi version classification (vd VSIC 2007→2018) **bắt buộc** CorrespondenceTable với `relationshipType` (1:1, 1:N, N:1, M:N) tường minh, không suy từ số dòng join. | GSIM site; proposal v1.2 (Phase 2 Must) |
| CLS-07 | SHOULD | Mỗi Map ghi `changeType` theo typology: VC1 đổi mã · VC2 đổi tên · RC1 xoá · RC2 tạo mới · RC3.1 gộp · RC3.2 tiếp quản · RC4.1 tách vỡ · RC4.2 tách ra · RC5 chuyển phần. Cho phép nhiều loại đồng thời. | StatCan ISIC Rev5 slides |
| CLS-08 | MUST | Mã ngành/nghề dạng số lưu là **string** (giữ số 0 đầu). `RecommendedDataType` tường minh. | Template_Danhmuc.xlsx |
| CLS-09 | MUST | ResponseDomain/ValueDomain kiểu mã chỉ được trỏ CodeList/Classification đã **PUBLISHED**. | fd-03 FR-005 |
| CLS-10 | MAY | ClassificationIndex (text tự do → item) để hỗ trợ gán mã tự động. | GSIM-UG |

```sql
CREATE TABLE statistical_classification (pk bigserial PRIMARY KEY, artefact_id uuid, version text, series_pk bigint NOT NULL,
  is_current boolean NOT NULL, is_floating boolean NOT NULL, is_update boolean NOT NULL,
  predecessor_pk bigint REFERENCES statistical_classification, changes_from_previous jsonb);
CREATE TABLE classification_item (pk bigserial PRIMARY KEY, classification_pk bigint NOT NULL REFERENCES statistical_classification,
  code text NOT NULL, level_number int NOT NULL, parent_pk bigint REFERENCES classification_item,
  name jsonb NOT NULL, includes jsonb, excludes jsonb, is_generated boolean DEFAULT false,
  valid_from date, valid_to date, UNIQUE (classification_pk, code));
CREATE TABLE correspondence_table (pk bigserial PRIMARY KEY, source_classification_pk bigint NOT NULL, target_classification_pk bigint NOT NULL,
  relationship_type text CHECK (relationship_type IN ('1:1','1:N','N:1','M:N')) NOT NULL);
CREATE TABLE classification_map (pk bigserial PRIMARY KEY, correspondence_pk bigint NOT NULL REFERENCES correspondence_table,
  source_item_pk bigint, target_item_pk bigint, is_partial boolean NOT NULL,
  change_types text[] CHECK (change_types <@ ARRAY['VC1','VC2','RC1','RC2','RC3.1','RC3.2','RC4.1','RC4.2','RC5']));
```

---

## §8. GSBPM — Metadata-driven production & truy vết

GSBPM 5.2 có 8 phase: 1 Specify Needs · 2 Design · 3 Build · 4 Collect · 5 Process · 6 Analyse · 7 Disseminate · 8 Evaluate. Các hoạt động xuyên suốt gồm Quality, **Metadata**, Data, Process Data, Knowledge, Data Supplier Management. `[Src: GSBPM p.6, 12]`

| Mã | Mức | Nguyên tắc | Nguồn |
|---|---|---|---|
| GSBPM-01 | MUST | Metadata **active**: được dùng để sinh validation, form, instrument, export. Không chỉ để tài liệu hoá sau publish. Mỗi tính năng cần trả lời được: "metadata này điều khiển bước sản xuất nào?" | HB-14.3; WP-01 NT3 |
| GSBPM-02 | MUST | Capture metadata sớm, tại nguồn, tự động nếu được. Vd import CSV/SPSS/Stata → tự sinh structural metadata ở trạng thái DRAFT. | GSBPM p.15 §46, 3.1; HB-14.3; FR-041 |
| GSBPM-03 | MUST | Mỗi phần tử metadata có **một nguồn xác thực**. Hệ thống tiêu thụ đọc qua API/SDK, không sao chép thủ công. | HB-14.3; FR-068/072 |
| GSBPM-04 | MUST | Run xử lý (phase 5) **ghim version** của Method/Rule/Parameter đã dùng vào ExecLog (early-bound). Chỉ được đọc bản PUBLISHED. Không hardcode rule trong engine. | fd-07 FR-050-053 |
| GSBPM-05 | MUST | Truy vết 2 chiều (tối thiểu 6 trace: requirement, concept, data, method, quality, release). Truy vấn được trong 1 thao tác. | FR-071 |
| GSBPM-06 | MUST | **Impact analysis** bắt buộc trước khi version-up/deprecate artefact dùng chung. | FR-031 (Must) |
| GSBPM-07 | MUST | Đổi trạng thái artefact → phát event để consumer làm mới cache. Consumer phải chạy được khi SMR sự cố (cache phía consumer). | FR-068; WP-03 NFR5 |
| GSBPM-08 | MUST | Tự động hoá luôn có **điểm dừng cho con người** trước publish. Không auto-publish kể cả khi mọi check đều pass. "Metadata hỗ trợ QA, không phải là QA." | DK-MDP slide 12 |
| GSBPM-09 | SHOULD | Yêu cầu tài liệu hoá khác nhau theo `data_state` (raw → input → microdata hoàn chỉnh → statistics → published). | DK-GOV slide 8-9 |
| GSBPM-10 | SHOULD | Mọi metadata object có Owner + Editor. Áp governance 6 vai trò: Owner, Editor, SME, Quality Reviewer, System Owner, Governance Body. | DK-GOV slide 14 |
| GSBPM-11 | MUST | API và UI dùng **cùng** kiểm tra quyền (không có cửa sau). | WB ME_API |

```sql
-- Truy vết & impact analysis (D3 = relational). Đặt sau interface TraceRepository để có thể đổi sang graph.
CREATE TABLE trace_link (source_urn text NOT NULL, target_urn text NOT NULL,
  link_type text NOT NULL,  -- REQUIREMENT|CONCEPT|DATA|METHOD|QUALITY|RELEASE|USES|DERIVED_FROM
  PRIMARY KEY (source_urn, target_urn, link_type));

-- Mọi artefact đang (trực tiếp/gián tiếp) phụ thuộc :urn
WITH RECURSIVE impacted(urn, depth) AS (
  SELECT source_urn, 1 FROM trace_link WHERE target_urn = :urn
  UNION
  SELECT t.source_urn, i.depth + 1 FROM trace_link t JOIN impacted i ON t.target_urn = i.urn WHERE i.depth < 20
) SELECT DISTINCT urn FROM impacted;
```

```java
/** Run log ghim chính xác version đã dùng (tái lập được). */
public record ExecLog(UUID runId, ArtefactRef processDesign, List<ArtefactRef> rules,
                      List<ArtefactRef> parameters, Instant startedAt, Instant endedAt, String status) {
    public ExecLog {
        Stream.concat(Stream.of(processDesign), Stream.concat(rules.stream(), parameters.stream()))
              .filter(ArtefactRef::lateBound).findAny()
              .ifPresent(r -> { throw new IllegalArgumentException("ExecLog cần ref early-bound: " + r); });
    }
}
```

---

## §9. SDC — Bảo mật & kiểm soát tiết lộ

| Mã | Mức | Nguyên tắc | Nguồn |
|---|---|---|---|
| SDC-01 | MUST | Dữ liệu cá nhân/đơn vị là tuyệt mật, chỉ dùng cho mục đích thống kê. API công khai **không bao giờ** trả record-level microdata. | UN FPOS P6 (HB-2.6) |
| SDC-02 | MUST | File cấp cho người dùng **không có định danh trực tiếp** (tên, địa chỉ, CCCD, MST, BHXH…). Khoá liên kết dùng mã giả danh vô nghĩa. | OCG §3.3 |
| SDC-03 | MUST | **Tham số SDC là metadata mật**: schema/phân vùng riêng, chỉ SDC Officer truy cập. | fd-09 FR-060-062 |
| SDC-04 | MUST | Unit dataset thiếu metadata disclosure-risk + pseudonymisation thì **không** được gán mức truy cập thấp hơn `licensed`. | fd-09 |
| SDC-05 | MUST | Quyền truy cập microdata **chỉ** sinh ra từ Provision Agreement ở trạng thái ACTIVE (đăng ký → Data Steward thẩm định → phê duyệt → agreement → cấp quyền → log). Không cấp tay. | fd-09 FR-063/064 |
| SDC-06 | MUST | Output checking 2 tầng: rule tự động (tiền kiểm) + người duyệt quyết định cuối. | OCG §1.2 |
| SDC-07 | MUST (D9=a) | Áp ngưỡng rule-of-thumb quốc tế: ≥10 đơn vị (không trọng số) mỗi ô bảng; mô hình ≥10 bậc tự do và ≥10 đơn vị. Giá trị đặt trong cấu hình mật, không hardcode. | OCG §2.2 |
| SDC-08 | SHOULD | Nguyên tắc four-eyes (2 người duyệt: kỹ thuật + nghiệp vụ). Tối thiểu 1 người. | OCG §3.10 |
| SDC-09 | MUST | Yêu cầu truy cập/xuất dữ liệu phải có mục đích, dataset, biến dùng, cam kết bảo mật đã ký. Thiếu → từ chối. | OCG §3.1, 3.6 |

```java
/** Tiền kiểm tự động; kết quả chỉ là gợi ý — người duyệt quyết định cuối (SDC-06). */
@Component
public class CellCountRule implements SdcRule {
    private final int minUnits; // lấy từ cấu hình mật (SDC-03), mặc định 10 theo OCG
    public CellCountRule(@Value("${sdc.min-units:10}") int minUnits) { this.minUnits = minUnits; }

    @Override public List<SdcFlag> check(AggregateTable t) {
        return t.cells().stream().filter(c -> c.unweightedCount() < minUnits)
                .map(c -> new SdcFlag(c.key(), "UNSAFE_LOW_COUNT", c.unweightedCount())).toList();
    }
}
```

---

## §10. AUTHZ — RBAC + object-level permission

### 10.1 Mô hình vai trò (tham chiếu WB Metadata Editor)

- **Global role** (theo user): `MEMBER` (chưa kích hoạt thì không có quyền) · `VIEWER` · `CONTRIBUTOR` · `COLLECTION_MANAGER` · `ADMIN`.
- **Object role** (theo từng Study/Collection): `VIEWER` (xem + export metadata, **không** export data) · `EDITOR` · `REVIEWER` (xem + lock/version) · `EDITOR_REVIEWER` · `OWNER` / `CO_OWNER` (thêm share, delete, chuyển owner).
- Thêm Study vào Collection cần **cả hai**: owner/admin trên Study và edit/admin trên Collection. `[Src: WB tech_roles_permissions]`

| Mã | Mức | Nguyên tắc |
|---|---|---|
| AUTHZ-01 | MUST | Global role → `hasRole()`. Quyền trên instance → `hasPermission()`. Không trộn hai tầng. |
| AUTHZ-02 | MUST | Kiểm tra quyền ở **service layer** (`@PreAuthorize`/`@PostFilter`), dùng chung cho UI và API. API key kế thừa đúng quyền của user. |
| AUTHZ-03 | MUST | Mỗi loại đối tượng (Study, Dataset, Variable, Collection, Classification) là một `acl_class` riêng. `object_id_identity` = `artefact_id` (UUID), để quyền áp cho mọi version. |
| AUTHZ-04 | MUST | Classification/CodeList dùng chung có ACL **riêng**, không kế thừa từ cây Study. `[Inference]` |
| AUTHZ-05 | MUST | Export data là permission riêng (`EXPORT_DATA`), tách khỏi READ metadata. |
| AUTHZ-06 | MUST | Quyền truy cập microdata chỉ cấp qua SDC-05. Mọi quyết định cho phép/từ chối đều được ghi audit. |
| AUTHZ-07 | SHOULD | Dùng `@PostFilter` cho danh sách lớn sẽ gây vấn đề phân trang → nên lọc bằng query (join bảng permission). `[Inference]` |

### 10.2 Cài đặt đã chốt (D5 = spring-security-acl, D6 = tree-fallback)

**Schema:** dùng script chính thức của Spring Security cho PostgreSQL (`createAclSchemaPostgres.sql` trong jar `spring-security-acl`). Chọn **biến thể có cột `acl_class.class_id_type`** và `acl_object_identity.object_id_identity varchar(36)`, để `object_id_identity` chứa được UUID (AUTHZ-03). Quản lý script bằng Flyway/Liquibase. Không tự viết lại DDL. `[Src: docs.spring.io ACL]`

| Bảng | Vai trò trong NSO-SMR |
|---|---|
| `acl_class` | 1 dòng / loại đối tượng: Collection, Study, Dataset, Variable, StatisticalClassification, CodeList |
| `acl_sid` | User (`principal=true`) hoặc role (`ROLE_*`, `principal=false`) |
| `acl_object_identity` | 1 dòng / `artefact_id`. `parent_object` tạo cây Collection→Study→Dataset→Variable (D6). Classification/CodeList: `parent_object = NULL` (AUTHZ-04) |
| `acl_entry` | ACE: `sid` + `mask` + `granting`. Thứ tự `ace_order` quyết định: entry khớp đầu tiên thắng |

```java
/** Permission riêng của NSO bên cạnh READ=1, WRITE=2, CREATE=4, DELETE=8, ADMINISTRATION=16. */
public class NsoPermission extends BasePermission {
    public static final Permission EXPORT_DATA = new NsoPermission(1 << 5, 'X'); // AUTHZ-05
    public static final Permission REVIEW      = new NsoPermission(1 << 6, 'V'); // lock/publish version
    protected NsoPermission(int mask, char code) { super(mask, code); }
}

@Configuration
@EnableMethodSecurity // Spring Security 6: thay cho @EnableGlobalMethodSecurity
class AclConfig {
    private static final PermissionFactory PERMISSIONS = new DefaultPermissionFactory(NsoPermission.class);

    @Bean AclAuthorizationStrategy aclAuthorizationStrategy() {
        return new AclAuthorizationStrategyImpl(new SimpleGrantedAuthority("ROLE_ADMIN")); // ai được sửa ACL
    }
    @Bean PermissionGrantingStrategy permissionGrantingStrategy() {
        return new DefaultPermissionGrantingStrategy(new ConsoleAuditLogger()); // thay bằng AuditLogger ghi DB (AUTHZ-06)
    }
    @Bean AclCache aclCache(CacheManager cacheManager, PermissionGrantingStrategy pgs, AclAuthorizationStrategy aas) {
        return new SpringCacheBasedAclCache(cacheManager.getCache("acl"), pgs, aas);
    }
    @Bean LookupStrategy lookupStrategy(DataSource ds, AclCache cache, AclAuthorizationStrategy aas,
                                        PermissionGrantingStrategy pgs) {
        var s = new BasicLookupStrategy(ds, cache, aas, pgs);
        s.setPermissionFactory(PERMISSIONS);
        s.setAclClassIdSupported(true); // object_id_identity là UUID
        return s;
    }
    @Bean JdbcMutableAclService aclService(DataSource ds, LookupStrategy ls, AclCache cache) {
        var s = new JdbcMutableAclService(ds, ls, cache);
        s.setAclClassIdSupported(true);
        s.setClassIdentityQuery("select currval(pg_get_serial_sequence('acl_class', 'id'))"); // PostgreSQL
        s.setSidIdentityQuery("select currval(pg_get_serial_sequence('acl_sid', 'id'))");
        return s;
    }
    @Bean MethodSecurityExpressionHandler expressionHandler(AclService aclService) {
        var evaluator = new AclPermissionEvaluator(aclService);
        evaluator.setPermissionFactory(PERMISSIONS); // cho phép hasPermission(..., 'EXPORT_DATA')
        var h = new DefaultMethodSecurityExpressionHandler();
        h.setPermissionEvaluator(evaluator);
        return h;
    }
}
```

```java
/** Tạo ACL khi tạo Study: owner có ADMINISTRATION, kế thừa quyền từ Collection chính (D6). */
@Service @RequiredArgsConstructor
class StudyAclService {
    private final MutableAclService aclService;

    @Transactional
    public void onStudyCreated(UUID studyId, UUID primaryCollectionId, String owner) {
        MutableAcl acl = aclService.createAcl(new ObjectIdentityImpl(Study.class, studyId));
        acl.setOwner(new PrincipalSid(owner));
        acl.setParent(aclService.readAclById(new ObjectIdentityImpl(Collection.class, primaryCollectionId)));
        acl.setEntriesInheriting(true);
        acl.insertAce(acl.getEntries().size(), BasePermission.ADMINISTRATION, new PrincipalSid(owner), true);
        aclService.updateAcl(acl);
    }
}

public interface StudyService {
    @PreAuthorize("hasPermission(#studyId, 'vn.gso.smr.domain.Study', 'READ')")          StudyDto get(UUID studyId);
    @PreAuthorize("hasPermission(#studyId, 'vn.gso.smr.domain.Study', 'WRITE')")         StudyDto update(UUID studyId, StudyUpdate cmd);
    @PreAuthorize("hasPermission(#studyId, 'vn.gso.smr.domain.Study', 'REVIEW')")        StudyDto publish(UUID studyId, String rationale);
    @PreAuthorize("hasPermission(#datasetId, 'vn.gso.smr.domain.Dataset', 'EXPORT_DATA')") Resource exportData(UUID datasetId);
}
```

Lưu ý khi cài đặt:
- `targetType` trong `hasPermission(id, type, perm)` là **tên class đầy đủ**, phải trùng `acl_class.class`. Package `vn.gso.smr.domain` ở trên chỉ là ví dụ.
- ACL chỉ có **1 parent**. Study thuộc nhiều Collection (WB cho phép N:N) → parent là Collection chủ quản. Các Collection khác chỉ để nhóm, không cấp quyền. `[Inference]`
- Chỉ việc thêm/xoá ACE mới cần evict cache. Chuyển version không cần đụng ACL vì ACL gắn với `artefact_id` (AUTHZ-03).
- Danh sách lớn (AUTHZ-07): không dùng `@PostFilter` trên trang dữ liệu. Nên join `acl_object_identity`/`acl_entry` trong query, hoặc lấy trước danh sách id được phép rồi phân trang.
- Trước khi nâng major version Spring Security, đọc release notes phần ACL `[Unverified: lộ trình deprecation]`.
- Cần test: owner, role kế thừa từ Collection, deny ACE ghi đè, Classification không kế thừa, `EXPORT_DATA` tách khỏi `READ`.

---

## §11. NSO — Ràng buộc riêng dự án NSO-SMR

Nguồn chính: `proposal-v12` (v1.2, 2026-06-13), có hiệu lực cao hơn `nso_proposal_catalog.md` v1.0.

### 11.1 Scope

- Hệ thống: **NSO-SMR** (Statistical Metadata Repository) = **control plane**. Không nằm trên đường đi dữ liệu (COL→DAT→DIS). Tên chính thức chờ Hội đồng duyệt.
- 9 phân hệ M1–M9, FR-001→FR-075, cộng Consumer Enablement (SDK + conformance kit).
- Lộ trình G1 Nền tảng → G2 Pilot → G3 Tích hợp → G4 Mở rộng, có go/no-go.

### 11.2 Quyết định đã chốt — AI không được đảo ngược

| Mã | Nội dung |
|---|---|
| NSO-01 | Canonical = GSIM 2.0. DDI-L 3.3 + SDMX 3.x là tầng hiện thực/trao đổi (D1=a). |
| NSO-02 | **Won't-have:** không lưu microdata thô (chỉ metadata + URI) — FR-035. Không tính toán thống kê (chọn mẫu, trọng số, imputation), chỉ lưu mô tả phương pháp — FR-034. Không thay DW/BI/CAPI. |
| NSO-03 | Workflow DRAFT → IN_REVIEW → PUBLISHED → DEPRECATED là lớp governance, không ghi vào DDI (DDI-02). |
| NSO-04 | Impact Analysis = Must (FR-031). CorrespondenceTable = Must ở Phase 2. 6-trace = Must từ MVP. |
| NSO-05 | StudyUnit PUBLISHED phải trace tới SPD PUBLISHED. SPD PUBLISHED phải trace tới ≥1 Statistical Need. StudyUnit ≠ SPD (SPD xuyên kỳ, StudyUnit là 1 kỳ). |
| NSO-06 | Weight Variable phải liên kết WeightingMethodology đã phê duyệt. |
| NSO-07 | Product không publish được nếu thiếu RMS PUBLISHED, chưa qua gate phase 6/7, hoặc thiếu trace. |
| NSO-08 | Portal công khai chỉ hiển thị PUBLISHED. SDMX REST tách khỏi API nội bộ (FR-025 vs FR-067). |
| NSO-09 | Phương án xây dựng hybrid: dùng thành phần mở cho phần "hàng hoá", tự xây registry GSIM, trace store, M7–M9 và cổng tích hợp. |
| NSO-13 | **Stack đã chốt (user xác nhận 2026-09-25):** ReactJS (frontend) + Spring Boot (backend) + PostgreSQL. Có thể dùng JSONB cho phần mở rộng và text đa ngôn ngữ (theo pptx NSO-Metadata-DWH slide 4). Agency = `vn.gso`. Phân quyền = `spring-security-acl` (D5). Ngưỡng SDC = quốc tế (D9). |

### 11.3 Chưa chốt — không được hardcode

| Mã | Nội dung | Cách xử lý trong code |
|---|---|---|
| NSO-10 | Sản phẩm nền (WB Metadata Editor / Colectica / FMR / tự xây) | Ẩn sau interface/adapter |
| NSO-11 | Trace store: graph hay quan hệ | `TraceRepository` (D3) |
| NSO-12 | Ngôn ngữ rule: VTL hay native | `RuleEngine` interface (D4) |
| NSO-14 | Tên thật các hệ vệ tinh (COL-01, PRC-01, DAT-01…) | Giữ placeholder, cấu hình hoá |

### 11.4 Thứ tự build (khi lập kế hoạch)

AC-02 Registry + AC-03 Repository → AC-05 Workflow + AC-06 Validation → AC-01 Gateway + AC-11 Portal → AC-04 Trace → AC-07 OpsMetadata + AC-15 Extractor → AC-13 DDI Adapter → AC-08 Quality Gate → AC-09 Access Governance → AC-14 SDMX + AC-12 Event + AC-16 SDK → AC-10 Semantic Search / AC-17 Harvest. `[Src: design-archimate §6.2]`

### 11.5 Quy tắc khác

- **NSO-15 (MUST):** Tên phần tử DDI trong code phải khớp nguyên văn. Các tên trong Phụ lục B "NOT VERIFIED" của `user-stories-ddi33` (vd NumericDomain/DateTimeDomain, các Coverage con, SubGroup → dùng GroupReference) phải đối chiếu XSD trước khi dùng.
- **NSO-16 (MUST):** MVP DDI Profile tối thiểu gồm StudyUnit, Concept/Universe, CodeList/Category, QuestionItem, Variable, PhysicalInstance.

---

## §12. Quy trình khi clone / tiếp nhận code

1. Chạy §1.2 để lấy module và mode.
2. Scout: tìm entity/bảng tương ứng các khái niệm §3 (Concept, Variable, CodeList, Classification, Study, Dataset, Permission).
3. Lập **gap report** tại `plans/reports/metadata-standards-gap-{date}.md`. Mỗi dòng gồm: rule | trạng thái (OK / GAP / N/A) | bằng chứng `file:line` | mức rủi ro | đề xuất.
4. Ưu tiên xử lý GAP theo thứ tự: CORE-04 (bất biến), SDC-01/02/03, AUTHZ-02, GSIM-02, rồi phần còn lại.
5. Mode `advisory` → chỉ báo cáo. Mode `strict` → sửa trong phạm vi task. Refactor lớn phải có plan và được user duyệt.
6. Không migrate dữ liệu, không đổi public API/schema khi chưa có xác nhận của user.

---

## §13. Checklist review PR (chỉ các module đã bật)

- [ ] Artefact mới có `agency/artefact_id/version`, URN sinh tự động (CORE-01..03)
- [ ] Bản PUBLISHED không bị sửa payload; có `versionRationale` (CORE-04/05)
- [ ] Reference ghi rõ early/late; run log và dữ liệu đã công bố dùng early (CORE-06, GSBPM-04)
- [ ] Không copy định nghĩa; tái sử dụng bằng reference (CORE-08)
- [ ] Text có language tag (CORE-09)
- [ ] Variable cascade đủ 4 tầng, không có FK tắt (GSIM-02/03)
- [ ] CodeList và Classification tách riêng; đổi version có CorrespondenceTable (CLS-01/06)
- [ ] Không ghi workflow state vào DDI XML (DDI-02)
- [ ] Impact analysis trước khi version-up/deprecate (GSBPM-06)
- [ ] Không auto-publish; có bước duyệt của con người (GSBPM-08, SDC-06)
- [ ] Không lộ microdata/định danh trực tiếp; tham số SDC ở phân vùng mật (SDC-01..03)
- [ ] Quyền kiểm tra ở service, UI = API; export data tách quyền riêng (AUTHZ-02/05)
- [ ] Không vi phạm won't-have; không hardcode các mục chưa chốt (NSO-02, NSO-10..14)

---

## §14. Câu hỏi mở & điểm chưa xác minh

Đã giải quyết 2026-09-25 (user xác nhận): stack, agency `vn.gso`, phân quyền `spring-security-acl`, ngưỡng SDC quốc tế.

1. **Đăng ký DDI Registry:** `vn.gso` đã được đăng ký trên registry.ddialliance.org chưa — `[Unverified]`.
2. **Lộ trình của `spring-security-acl`** trong các bản Spring Security sau này — `[Unverified]`. Kiểm tra khi nâng version.
3. **Proposal v1.2 §A.5** vẫn ghi "chờ PoC G1" → nên cập nhật proposal cho khớp với stack đã chốt.
4. **Deprecation trong DDI-L 3.3:** không tìm thấy field chuẩn; tài liệu này dùng version + Note `[Inference]`.
5. **Population:** DDI-CDI có class riêng `[Unverified]`; chưa đọc spec DDI-CDI.
6. **Mapping GSIM↔DDI↔SDMX:** không có bảng chính thức. Copenhagen Mapping và GSIM Statistical Classification Model trên statswiki.unece.org không truy cập được (HTTP 403).
7. **Mức DDI dự kiến:** ToR chỉ ghi "DDI-Lifecycle", không ghi rõ phiên bản 3.2/3.3.
8. **Mapping đối tượng ↔ ACL** (§10) là suy luận `[Inference]`, cần BA xác nhận. D6 cũng vậy.
9. **Nguồn chưa đọc được:** NotebookLM (cần đăng nhập Google); SVN gốc (401 — đã dùng bản backup `D:\Tai-lieu-bak\CSDL_VIMO`, có thể cũ hơn); `01.HoSoThau` không có trong backup; UN Handbook ch.8/12/15 mới đọc mục lục; XSD DDI 3.3 chưa mở.

---

## §15. Nguồn

| Ký hiệu | Nguồn |
|---|---|
| Web:* | DDI-L 3.3 model — https://ddialliance.github.io/ddimodel-web/DDI-L-3.3/ |
| TG | DDI Lifecycle 3.3 Technical Guide (PDF) — `30.REFERENCE/30.OTHER/04.TaiLieuQuocTe/DDI/` |
| BP | DDI 3.2 Best Practices (PDF) — cùng thư mục |
| DDITL_05/08/09/10/12, DDI-CV, unit-type slides | DDI Training Materials (pptx) — `DDI/DDI_TrainingMaterials/` |
| GSIM site | https://unece.github.io/GSIM-2.0/ · https://github.com/UNECE/GSIM-2.0 |
| GSIM-UG | GSIM User Guide (ECE/CES/STAT/2024/3) — https://unece.org/sites/default/files/2025-03/GSIM%20User%20Guide.pdf |
| GSBPM | GSBPM v5.2 (CES endorsed) — `04.TaiLieuQuocTe/GSBPM/` |
| DK-2016 | Towards Common Metadata Using GSIM and DDI 3.2 (Statistics Denmark) — `ThongKeDanMach/2025.12/` |
| DK-GOV / DK-MDP | Session 1.3 Metadata Strategy & Governance / Session 2.2 Metadata-driven production — `ThongKeDanMach/2026.06/` |
| StatCan ISIC Rev5 | Session05_Pres2 GSIM for documenting changes in classification versions — `ThongKeDanMach/2026.06/` |
| WB | World Bank Metadata Editor docs — https://worldbank.github.io/metadata-editor-docs/ (tech_roles_permissions, ME_API, managing_projects, managing_collections) |
| HB-x.y | UN Handbook on Management & Organization of NSS — https://projects.officialstatistics.org/hb-mgnt-org-nss/handbook/intro.html (2.6, 11.4, 14.3) |
| OCG | Output-checking-guidelines.pdf — `04.TaiLieuQuocTe/` |
| Baeldung | https://www.baeldung.com/spring-security-acl · docs.spring.io ACL |
| proposal-v12, fd-xx, wp-xx, design-archimate, user-stories-ddi33, Template_Danhmuc, slide Danh mục | `30.REFERENCE/30.OTHER/05.KetQuaNghienCuu/TungNS_TongHop/` và `Danh mục/` |

Báo cáo nghiên cứu chi tiết (có trích dẫn trang/slide): `plans/reports/researcher-260925-1559-ddi-l-33.md`, `researcher-260925-1559-gsim-gsbpm.md`, `researcher-260925-1551-wb-handbook-acl.md`.
