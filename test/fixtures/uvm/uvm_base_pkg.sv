// Minimal UVM base classes so the fixture parses without the real library.
package uvm_base_pkg;

  class uvm_object;
    virtual function void build_phase(int phase);
    endfunction

    virtual task run_phase(int phase);
    endtask

    function new(string name = "uvm_object");
    endfunction
  endclass

  class uvm_component extends uvm_object;
    protected int unsigned depth;

    function new(string name = "uvm_component");
      super.new(name);
    endfunction

    protected function void build_phase(int phase);
      super.build_phase(phase);
      this.depth = 0;
    endfunction

    virtual task run_phase(int phase);
    endtask
  endclass

  class uvm_test extends uvm_component;
    local int unsigned errors;

    function new(string name = "uvm_test");
      super.new(name);
    endfunction

    virtual function void build_phase(int phase);
      super.build_phase(phase);
      this.report_summary();
    endfunction

    local function void report_summary();
      errors = 0;
    endfunction
  endclass

  class uvm_env extends uvm_component;
    function new(string name = "uvm_env");
      super.new(name);
    endfunction

    protected function void build_phase(int phase);
      super.build_phase(phase);
    endfunction
  endclass

  class uvm_driver extends uvm_component;
    function new(string name = "uvm_driver");
      super.new(name);
    endfunction

    virtual task run_phase(int phase);
      this.drive();
    endtask

    virtual task drive();
    endtask
  endclass

  class uvm_sequence_item extends uvm_object;
    function new(string name = "uvm_sequence_item");
      super.new(name);
    endfunction
  endclass

endpackage
