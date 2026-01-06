# Enhanced Code Review Patterns

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   This extends the bundled code-review.md with              │
│   company-specific security requirements and patterns.      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

> **Load when**: Automated PR review via queue, security-focused code audit
> **Extends**: `references/domains/code-review.md`

## Company Security Standards

### Critical Checks (Must Block Merge)

1. **Authentication Bypass**
   - Verify all protected endpoints use auth middleware
   - Check for missing authorization checks on sensitive data
   - Validate JWT/session handling

2. **Injection Vulnerabilities**
   - SQL: Parameterized queries only (no string concatenation)
   - NoSQL: Validate query operators, no `$where`
   - Command: No shell=True, use subprocess with arrays
   - XSS: Content-Type headers, output encoding

3. **Data Exposure**
   - No secrets in code (API keys, passwords, tokens)
   - PII handling follows data classification
   - Logs don't contain sensitive data

4. **Access Control**
   - Resource ownership validation
   - Role-based access properly enforced
   - No IDOR vulnerabilities

### Performance Standards

1. **Database Queries**
   - No N+1 patterns (use eager loading or batching)
   - New queries must have EXPLAIN analysis for large tables
   - Indexes required for frequently filtered columns

2. **API Response Times**
   - Endpoints should respond < 200ms (p95)
   - Long operations must be async/queued

3. **Memory Management**
   - Streams for large data processing
   - Proper cleanup of event listeners
   - No unbounded caches

### Code Quality Requirements

1. **Test Coverage**
   - New code paths require tests
   - Critical business logic needs integration tests
   - Edge cases documented in tests

2. **Error Handling**
   - All async operations have error handlers
   - User-facing errors are sanitized
   - Internal errors are logged with context

3. **Documentation**
   - Public APIs have JSDoc/docstrings
   - Complex algorithms have inline comments
   - Breaking changes noted in PR description

## Review Output Format

```markdown
## Security Review

### 🔴 Critical (Must Fix)
- [File:Line] Description of issue
  - **Risk**: What could happen
  - **Fix**: How to resolve

### 🟡 Important (Should Fix)
- [File:Line] Description
  - **Recommendation**: Suggested improvement

### 🟢 Approved Patterns
- Good use of X in Y

## Performance Assessment

- [ ] Query analysis complete
- [ ] No N+1 patterns detected
- [ ] Response time impact: Low/Medium/High

## Test Coverage

- [ ] New code paths covered
- [ ] Edge cases tested

## Overall: ✅ Approve / ⚠️ Approve with comments / ❌ Request changes
```

## Automated Review Workflow

When processing a review request:

1. **Context Gathering** (Explore agent)
   - Fetch PR diff and description
   - Identify affected systems/services
   - Check for related security policies

2. **Parallel Analysis** (Background agents)
   - Security scan (OWASP patterns)
   - Performance analysis (query patterns, complexity)
   - Test coverage check

3. **Synthesis** (Main agent)
   - Aggregate findings
   - Prioritize by severity
   - Format review output

```
# Launch parallel analysis
Task(subagent_type="general-purpose",
     prompt="Security review focusing on auth, injection, data exposure",
     model="opus", run_in_background=True)
Task(subagent_type="general-purpose",
     prompt="Performance review: queries, complexity, caching",
     model="sonnet", run_in_background=True)
```
