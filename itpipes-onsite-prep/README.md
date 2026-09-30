# ITpipes onsite prep

Study material for the 60-minute design and code review. This is **not** part of the take-home submission — keep it off anything you send to the panel.

- Walkthrough, numbers, challenge questions, and soft spots: [onsite-prep.md](./onsite-prep.md)
- Diagram sources (Mermaid): [diagrams/src/](./diagrams/src/)

## Diagrams

### 1. Architecture

![Revised architecture: split imports and exports lanes](diagrams/01-architecture.png)

### 2. Import, end to end

![Import sequence: POST through claim, object-first write, terminal conditional write](diagrams/02-import-sequence.png)

### 3. Export — same control flow, different economics

![Export sequence: task protection, visibility heartbeat, JVM subprocess, multipart upload](diagrams/03-export-sequence.png)

### 4. Job lifecycle

![Job record state machine: queued, running, succeeded, failed](diagrams/04-job-state-machine.png)

### 5. Handler branches

![Handler decision tree with ack, retry, and fail leaves](diagrams/05-failure-paths.png)

### 6. Delivery pipeline

![PR through canary to rolling deploy; stop vs reverse](diagrams/06-delivery-pipeline.png)

### 7. Observability map

![Who emits each signal and which alarm it feeds](diagrams/07-observability-map.png)
