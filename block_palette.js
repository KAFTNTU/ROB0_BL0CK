/* Apply the editor palette before Blockly paints the toolbox and workspace. */
(function(){
  'use strict';

  const palette={
    start_hat:'#5ba55b',
    robot_stop:'#a55b5b',
    robot_move:'#5b67a5',
    robot_move_soft:'#5b67a5',
    robot_set_speed:'#5b67a5',
    robot_turn_timed:'#5b67a5',
    motor_single:'#745ba5',
    motor_soft_start:'#244fa8',
    motor_soft_stop:'#244fa8',
    motor_soft_change:'#244fa8',
    motor_on_time:'#244fa8',
    run_once:'#5ba55b',
    do_after_delay:'#5ba55b',
    when_signal_rises:'#5b80a5',
    wait_condition_timeout:'#5b80a5',
    rb_map:'#5c81a6',
    rb_modulo:'#5c81a6',
    rb_break:'#5ba55b',
    rb_break_if_stable:'#5b80a5',
    disp_clear:'#2563eb',
    disp_send:'#2563eb',
    disp_hud:'#2563eb',
    disp_text:'#2563eb',
    disp_number:'#2563eb',
    disp_pixel:'#2563eb',
    disp_line:'#2563eb',
    disp_rect:'#2563eb',
    disp_circle:'#2563eb',
    disp_smile:'#2563eb',
    disp_fill:'#2563eb',
    disp_pixel_dyn:'#2563eb',
    disp_pixel_clear:'#2563eb',
    disp_pixel_get:'#2563eb',
    disp_text_dyn:'#2563eb',
    disp_random_pixels:'#2563eb',
    disp_paint:'#2563eb',
    disp_anim_frame:'#2563eb',
    disp_anim_save:'#2563eb',
    disp_anim_load:'#2563eb',
    disp_anim_play:'#2563eb',
    disp_anim_stop:'#2563eb',
    go_home:'#5b67a5',
    track_action:'#5b67a5',
    start_line_action:'#5b67a5',
    joy_x:'#5b67a5',
    joy_y:'#5b67a5',
    manip_servo_channel:'#244fa8',
    manip_servo_timed:'#244fa8',
    manip_servo_from_to:'#244fa8',
    calibrate_speed_line:'#b36c0c',
    latch_set:'#b36c0c',
    latch_get:'#b36c0c',
    latch_reset:'#b36c0c'
  };

  function apply(){
    const B=window.Blockly;
    if(!B||!B.Blocks)return;
    for(const [type,colour] of Object.entries(palette)){
      const definition=B.Blocks[type];
      if(!definition)continue;
      if(!definition.__rbPaletteWrapped){
        const original=definition.init;
        definition.init=function(){
          original.call(this);
          this.setColour(colour);
        };
        definition.__rbPaletteWrapped=true;
      }
    }
    const workspace=window.workspace||B.getMainWorkspace?.();
    if(!workspace)return;
    for(const block of workspace.getAllBlocks?.(false)||[]){
      const colour=palette[block.type];
      if(colour)block.setColour(colour);
    }
    workspace.getToolbox?.()?.refreshSelection?.();
  }

  apply();
  [0,25,100,250,500].forEach(delay=>setTimeout(apply,delay));
  window.addEventListener('load',apply);
})();
